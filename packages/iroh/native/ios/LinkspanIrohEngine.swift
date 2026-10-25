import Foundation
import CoreFoundation
#if canImport(IrohLib)
import IrohLib
#endif

/// Ordered SDK bytes only. The caller retains Noise and the application pin.
actor LinkspanIrohEngine {
  private struct SafeError: Error { let code: String }
  private struct Options: Sendable {
    let ticket: String
    let endpointId: String
    let key: String?
    let urls: [String]?
    let token: String?
    let expiry: Double?
  }
  private final class PoolEntry: @unchecked Sendable {
    var task: Task<Endpoint, Error>!
    let configuration: [String]?
    var references = 0
    var ended = false
    init(_ configuration: [String]?) { self.configuration = configuration }
  }
  private final class Carrier: @unchecked Sendable {
    let connection: Connection
    let stream: BiStream
    let key: String
    let pool: PoolEntry
    var ended = false
    init(_ connection: Connection, _ stream: BiStream, _ key: String, _ pool: PoolEntry) {
      self.connection = connection; self.stream = stream; self.key = key; self.pool = pool
    }
  }
  private final class Entry: @unchecked Sendable {
    let task: Task<Carrier, Error>
    var carrier: Carrier?
    var reading = false
    var writing = false
    var expiry: Task<Void, Never>?
    var waiter: CheckedContinuation<Carrier, Error>?
    init(_ task: Task<Carrier, Error>) { self.task = task }
  }
  private var streams: [String: Entry] = [:]
  private var endpoints: [String: PoolEntry] = [:]
  private var disposed = false
  private let alpn = Data("linkspan/iroh-noise/1".utf8)

  /// Only stable, safe error codes cross the local native boundary.
  func request(_ json: String) async -> String {
    var request: [String: Any]?
    do {
      guard json.utf8.count <= 800_000 else { throw SafeError(code: "resource_exhausted") }
      guard let object = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { throw SafeError(code: "invalid_argument") }
      request = object
      guard let id = object["streamId"] as? String, matches(id, "^[0-9a-f]{32}$"), let method = object["method"] as? String else { throw SafeError(code: "invalid_argument") }
      guard !disposed else { throw SafeError(code: "closed") }
      var value: Any = NSNull()
      switch method {
      case "identity":
        let key = SecretKey.generate()
        value = ["privateKey": hex(key.toBytes()), "publicKey": key.`public`().description]
      case "connect":
        guard let arguments = object["args"] as? [String: Any] else { throw SafeError(code: "invalid_argument") }
        value = try await connect(id, options(arguments))
      case "read", "write":
        guard let entry = streams[id] else { throw SafeError(code: "closed") }
        if method == "read" {
          guard !entry.reading else { throw SafeError(code: "resource_exhausted") }
          entry.reading = true
          defer { entry.reading = false }
          let carrier = try await entry.task.value
          if !carrier.ended {
            let bytes = try await carrier.stream.recv().read(sizeLimit: 65_536)
            if !bytes.isEmpty { value = bytes.map(Int.init) }
          }
        } else {
          guard !entry.writing else { throw SafeError(code: "resource_exhausted") }
          entry.writing = true
          defer { entry.writing = false }
          let buffer = try bytes(object["args"])
          let carrier = try await entry.task.value
          guard !carrier.ended else { throw SafeError(code: "closed") }
          try await carrier.stream.send().writeAll(buf: buffer)
        }
      case "abort": await abort(id)
      case "close":
        if let entry = streams.removeValue(forKey: id) {
          entry.expiry?.cancel()
          if let carrier = entry.carrier { try await close(carrier, orderly: true) }
          else { entry.task.cancel() }
        }
      default: throw SafeError(code: "invalid_argument")
      }
      return encode(["success": true, "value": value])
    } catch {
      if let method = request?["method"] as? String, ["connect", "read", "write", "close"].contains(method), let id = request?["streamId"] as? String { await abort(id) }
      let code = (error as? SafeError)?.code ?? (error is CancellationError ? "cancelled" : "transport_error")
      return encode(["success": false, "code": code])
    }
  }

  private func connect(_ id: String, _ options: Options) async throws -> [String: String] {
    guard streams[id] == nil else { throw SafeError(code: "invalid_argument") }
    guard streams.count < 128 else { throw SafeError(code: "resource_exhausted") }
    let entry = Entry(Task { try await self.timedDial(id, options) })
    streams[id] = entry
    var carrier: Carrier?
    do {
      let current: Carrier = try await withCheckedThrowingContinuation { continuation in
        entry.waiter = continuation
        Task {
          let result = await entry.task.result
          await self.deliver(entry, result)
        }
      }
      carrier = current
      guard !disposed, streams[id] === entry else { throw SafeError(code: "cancelled") }
      entry.carrier = current
      if let expiry = options.expiry {
        entry.expiry = Task {
          do { try await Task.sleep(nanoseconds: UInt64(max(0, expiry - Date().timeIntervalSince1970 * 1000) * 1_000_000)) }
          catch { return }
          await self.abort(id)
        }
      }
      return ["remoteEndpointId": current.connection.remoteId().description]
    } catch {
      if let carrier { try? await close(carrier, orderly: false) }
      await abort(id)
      throw error
    }
  }
  private func deliver(_ entry: Entry, _ result: Result<Carrier, Error>) async {
    if let waiter = entry.waiter { entry.waiter = nil; waiter.resume(with: result) }
    else if case let .success(carrier) = result { try? await close(carrier, orderly: false) }
  }
  private func timedDial(_ id: String, _ options: Options) async throws -> Carrier {
    try await withThrowingTaskGroup(of: Carrier.self) { group in
      group.addTask { try await self.dial(id, options) }
      group.addTask { try await Task.sleep(nanoseconds: 30_000_000_000); throw SafeError(code: "deadline_exceeded") }
      defer { group.cancelAll() }
      return try await group.next()!
    }
  }
  private func dial(_ id: String, _ options: Options) async throws -> Carrier {
    let address: EndpointAddr
    do { address = try EndpointTicket.fromString(str: options.ticket).endpointAddr() }
    catch { throw SafeError(code: "invalid_argument") }
    guard address.id().description == options.endpointId else { throw SafeError(code: "identity_mismatch") }
    let key = options.key ?? "ephemeral:\(id)"
    let pool = try acquire(key, options)
    var connection: Connection?
    do {
      let endpoint = try await pool.task.value
      try Task.checkCancellation()
      if let token = options.token { for url in options.urls ?? [] { try await endpoint.insertRelay(config: RelayConfig(url: url, authToken: token)) } }
      let connected = try await endpoint.connect(addr: address, alpn: alpn)
      connection = connected
      guard connected.remoteId().description == options.endpointId else { throw SafeError(code: "identity_mismatch") }
      try connected.setMaxConcurrentBiStreams(count: 1)
      try connected.setMaxConcurrentUniStreams(count: 0)
      try connected.setReceiveWindow(count: 524_288)
      let stream = try await connected.openBi()
      try Task.checkCancellation()
      return Carrier(connected, stream, key, pool)
    } catch {
      try? connection?.close(errorCode: 1, reason: Data())
      await release(key, pool)
      throw error
    }
  }
  private func acquire(_ key: String, _ options: Options) throws -> PoolEntry {
    guard !disposed else { throw SafeError(code: "closed") }
    if let entry = endpoints[key] {
      guard entry.configuration == options.urls else { throw SafeError(code: "invalid_argument") }
      entry.references += 1
      return entry
    }
    guard endpoints.count < 128 else { throw SafeError(code: "resource_exhausted") }
    let entry = PoolEntry(options.urls)
    entry.references = 1
    entry.task = Task {
      let builder = EndpointBuilder()
      if options.urls?.isEmpty == true { builder.applyMinimal() } else { builder.applyN0() }
      builder.alpns(alpns: [self.alpn])
      if let key = options.key { try builder.secretKey(bytes: self.unhex(key)) }
      if let urls = options.urls {
        if urls.isEmpty { builder.relayMode(mode: RelayMode.disabled()) }
        else {
          let map = RelayMap.empty()
          for url in urls { try map.insert(config: RelayConfig(url: url, authToken: options.token)) }
          builder.relayMode(mode: RelayMode.custom(map: map))
        }
      }
      let endpoint = try await builder.bind()
      if entry.ended || self.disposed { await self.shutdown(endpoint); throw CancellationError() }
      return endpoint
    }
    endpoints[key] = entry
    return entry
  }
  private func release(_ key: String, _ pool: PoolEntry) async {
    pool.references -= 1
    if pool.references != 0 { return }
    if endpoints[key] === pool { endpoints.removeValue(forKey: key) }
    await closePool(pool)
  }
  private func closePool(_ pool: PoolEntry) async {
    if pool.ended { return }
    pool.ended = true
    pool.task.cancel()
    if let endpoint = try? await pool.task.value { await shutdown(endpoint) }
  }
  private func shutdown(_ endpoint: Endpoint) async {
    // Cleanup must remain active when the dialing task itself was cancelled.
    await Task.detached {
      await withTaskGroup(of: Void.self) { group in
        group.addTask { try? await endpoint.close() }
        group.addTask { try? await Task.sleep(nanoseconds: 5_000_000_000) }
        _ = await group.next(); group.cancelAll()
      }
    }.value
  }
  private func close(_ carrier: Carrier, orderly: Bool) async throws {
    if carrier.ended { return }
    carrier.ended = true
    var failure: Error?
    if orderly { do { try await carrier.stream.send().finish() } catch { failure = error } }
    try? carrier.connection.close(errorCode: orderly ? 0 : 1, reason: Data())
    await release(carrier.key, carrier.pool)
    if let failure { throw failure }
  }
  private func abort(_ id: String) async {
    guard let entry = streams.removeValue(forKey: id) else { return }
    entry.expiry?.cancel()
    entry.waiter?.resume(throwing: CancellationError()); entry.waiter = nil
    entry.task.cancel()
    if let carrier = entry.carrier { try? await close(carrier, orderly: false) }
  }
  func dispose() async {
    if disposed { return }
    disposed = true
    for id in Array(streams.keys) { await abort(id) }
    let pools = Array(endpoints.values)
    endpoints.removeAll()
    for pool in pools { await closePool(pool) }
  }

  private func options(_ object: [String: Any]) throws -> Options {
    guard let ticket = object["ticket"] as? String, (16...8192).contains(ticket.utf8.count), let id = object["expectedEndpointId"] as? String, matches(id, "^[0-9a-f]{64}$") else { throw SafeError(code: "invalid_argument") }
    let key = try optionalString(object, "clientKey")
    if let key, !matches(key, "^[0-9a-f]{64}$") { throw SafeError(code: "invalid_argument") }
    let token = try optionalString(object, "relayToken")
    var urls: [String]?
    if let value = object["relayUrls"], !(value is NSNull) {
      guard let values = value as? [String], values.count <= 8 else { throw SafeError(code: "invalid_argument") }
      for value in values {
        guard value.utf8.count <= 2048, let url = URLComponents(string: value), url.scheme == "https", !(url.host?.isEmpty ?? true), url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { throw SafeError(code: "invalid_argument") }
      }
      urls = values
    }
    let expiry = (object["relayTokenExpiresAt"] as? NSNumber)?.doubleValue
    if let token {
      let now = Date().timeIntervalSince1970 * 1000
      guard !token.isEmpty, token.utf8.count <= 16384, !token.contains(where: { $0 == "\r" || $0 == "\n" || $0 == "\0" }), key != nil, !(urls?.isEmpty ?? true), let expiry, expiry.isFinite, expiry > now, expiry <= now + 86_400_000 else { throw SafeError(code: "invalid_argument") }
    }
    return Options(ticket: ticket, endpointId: id, key: key, urls: urls, token: token, expiry: expiry)
  }
  private func optionalString(_ object: [String: Any], _ key: String) throws -> String? {
    guard let value = object[key], !(value is NSNull) else { return nil }
    guard let string = value as? String else { throw SafeError(code: "invalid_argument") }
    return string
  }
  private func bytes(_ value: Any?) throws -> Data {
    guard let values = value as? [NSNumber], values.count <= 131_072 else { throw SafeError(code: "invalid_argument") }
    return try Data(values.map { value in
      let number = value.doubleValue
      guard CFGetTypeID(value) != CFBooleanGetTypeID(), number.isFinite, number.rounded() == number, (0...255).contains(number) else { throw SafeError(code: "invalid_argument") }
      return UInt8(number)
    })
  }
  private func matches(_ value: String, _ pattern: String) -> Bool { value.range(of: pattern, options: .regularExpression) != nil }
  private func hex(_ bytes: Data) -> String { bytes.map { String(format: "%02x", $0) }.joined() }
  private func unhex(_ value: String) -> Data {
    let characters = Array(value.utf8)
    return Data(stride(from: 0, to: characters.count, by: 2).map { UInt8(String(bytes: characters[$0...$0 + 1], encoding: .utf8)!, radix: 16)! })
  }
  private func encode(_ value: [String: Any]) -> String {
    guard let bytes = try? JSONSerialization.data(withJSONObject: value), let json = String(data: bytes, encoding: .utf8) else { return "{\"success\":false,\"code\":\"protocol_error\"}" }
    return json
  }
}

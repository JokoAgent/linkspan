import ExpoModulesCore
import Foundation

public final class LinkspanIrohModule: Module {
  private let lock = NSLock()
  private var engine: LinkspanIrohEngine?
  private var destroyed = false
  private var generation: UInt64 = 0
  private var retiring: Task<Void, Never>?
  private func snapshot(allowCreate: Bool) -> (UInt64, Task<Void, Never>?)? {
    lock.lock(); defer { lock.unlock() }
    if destroyed || (!allowCreate && engine == nil) { return nil }
    return (generation, retiring)
  }
  private func acquire(_ expected: UInt64, allowCreate: Bool) -> (LinkspanIrohEngine?, Bool) {
    lock.lock(); defer { lock.unlock() }
    if generation != expected { return (nil, true) }
    if destroyed { return (nil, false) }
    if let engine { return (engine, false) }
    if !allowCreate { return (nil, false) }
    let value = LinkspanIrohEngine(); engine = value; return (value, false)
  }
  private func current(allowCreate: Bool) async -> LinkspanIrohEngine? {
    while let (generation, previous) = snapshot(allowCreate: allowCreate) {
      await previous?.value
      if Task.isCancelled { return nil }
      let (value, changed) = acquire(generation, allowCreate: allowCreate)
      if !changed { return value }
    }
    return nil
  }
  private func take(destroy: Bool = false) -> Task<Void, Never>? {
    lock.lock(); defer { lock.unlock() }
    if destroy { destroyed = true }
    generation &+= 1
    guard let old = engine else { return retiring }
    engine = nil
    let previous = retiring
    let task = Task { await previous?.value; await old.dispose() }
    retiring = task
    return task
  }
  private func available() -> Bool {
    lock.lock(); defer { lock.unlock() }
    return !destroyed
  }
  public func definition() -> ModuleDefinition {
    Name("LinkspanIroh")
    Function("isAvailable") { self.available() }
    AsyncFunction("request") { (request: String) async -> String in
      guard request.utf8.count <= 800_000 else { return "{\"success\":false,\"code\":\"resource_exhausted\"}" }
      let object = (try? JSONSerialization.jsonObject(with: Data(request.utf8))) as? [String: Any]
      let method = object?["method"] as? String
      guard let engine = await self.current(allowCreate: method == "connect" || method == "identity") else { return "{\"success\":false,\"code\":\"closed\"}" }
      return await engine.request(request)
    }
    AsyncFunction("dispose") { () async -> Void in if let task = self.take() { await task.value } }
    OnDestroy { _ = self.take(destroy: true) }
  }
}

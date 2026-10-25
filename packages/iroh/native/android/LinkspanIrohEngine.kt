package app.joko.linkspan

import computer.iroh.BiStream
import computer.iroh.Connection
import computer.iroh.Endpoint
import computer.iroh.EndpointBuilder
import computer.iroh.EndpointTicket
import computer.iroh.RelayConfig
import computer.iroh.RelayMap
import computer.iroh.RelayMode
import computer.iroh.SecretKey
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.selects.select
import org.json.JSONArray
import org.json.JSONObject

/** The native bridge carries only SDK stream bytes. Noise remains in the caller. */
class LinkspanIrohEngine(private val beforeBind: () -> Unit = {}) {
  private class SafeError(val code: String) : Exception()
  private data class Options(val ticket: String, val endpointId: String, val key: String?, val urls: List<String>?, val token: String?, val expiry: Long?)
  private class PoolEntry(val task: Deferred<Endpoint>, val configuration: List<String>?, var references: Int = 0) {
    val ended = AtomicBoolean(false)
  }
  private class Entry(val task: Deferred<Carrier>) {
    val cancelled = CompletableDeferred<Unit>()
    val reading = AtomicBoolean(false)
    val writing = AtomicBoolean(false)
    @Volatile var carrier: Carrier? = null
    @Volatile var expiry: Job? = null
  }
  private val lock = Any()
  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private val streams = HashMap<String, Entry>()
  private val endpoints = HashMap<String, PoolEntry>()
  private var disposed = false

  private inner class Lease(val endpoint: Endpoint, private val key: String, private val entry: PoolEntry) {
    private val released = AtomicBoolean(false)
    suspend fun release() {
      if (!released.compareAndSet(false, true)) return
      val last = synchronized(lock) {
        entry.references--
        if (entry.references == 0) {
          if (endpoints[key] === entry) endpoints.remove(key)
          true
        } else false
      }
      if (last) closeEndpoint(entry, endpoint)
    }
  }
  private inner class Carrier(val connection: Connection, val bi: BiStream, private val lease: Lease) {
    private val ended = AtomicBoolean(false)
    val remoteEndpointId: String get() = connection.remoteId().toString()
    suspend fun read(): ByteArray = if (ended.get()) byteArrayOf() else bi.recv().read(65536u)
    suspend fun write(bytes: ByteArray) {
      if (ended.get()) throw SafeError("closed")
      bi.send().writeAll(bytes)
    }
    suspend fun close() {
      if (!ended.compareAndSet(false, true)) return
      try { bi.send().finish() }
      finally { runCatching { connection.close(0, byteArrayOf()) }; lease.release() }
    }
    fun abort() {
      if (!ended.compareAndSet(false, true)) return
      runCatching { connection.close(1, byteArrayOf()) }
      scope.launch { withContext(NonCancellable) { lease.release() } }
    }
  }

  /** No exception text, URLs, tickets, keys, or vendor diagnostics cross this API. */
  suspend fun request(json: String): String {
    var request: JSONObject? = null
    return try {
      if (json.length > 800000) throw SafeError("resource_exhausted")
      request = JSONObject(json)
      val id = request.optString("streamId")
      val method = request.optString("method")
      if (!id.matches(Regex("[0-9a-f]{32}"))) throw SafeError("invalid_argument")
      synchronized(lock) { if (disposed) throw SafeError("closed") }
      val result: Any? = when (method) {
        "identity" -> {
          val key = SecretKey.generate()
          JSONObject().put("privateKey", hex(key.toBytes())).put("publicKey", key.public().toString())
        }
        "connect" -> connect(id, options(request.optJSONObject("args") ?: throw SafeError("invalid_argument")))
        "read", "write" -> {
          val entry = synchronized(lock) { streams[id] } ?: throw SafeError("closed")
          val pending = if (method == "read") entry.reading else entry.writing
          if (!pending.compareAndSet(false, true)) throw SafeError("resource_exhausted")
          try {
            val carrier = entry.task.await()
            if (method == "read") {
              val bytes = carrier.read()
              if (bytes.isEmpty()) null else JSONArray().apply { bytes.forEach { put(it.toInt() and 255) } }
            } else { carrier.write(bytes(request.optJSONArray("args") ?: throw SafeError("invalid_argument"))); null }
          } finally { pending.set(false) }
        }
        "abort" -> { abort(id); null }
        "close" -> {
          val entry = synchronized(lock) { streams.remove(id) }
          entry?.expiry?.cancel()
          if (entry != null) {
            if (entry.carrier == null) entry.task.cancel()
            else entry.carrier!!.close()
          }
          null
        }
        else -> throw SafeError("invalid_argument")
      }
      JSONObject().put("success", true).put("value", result ?: JSONObject.NULL).toString()
    } catch (error: Exception) {
      val method = request?.optString("method")
      if (method in listOf("connect", "read", "write", "close")) request?.optString("streamId")?.let { abort(it) }
      val code = when (error) {
        is SafeError -> error.code
        is TimeoutCancellationException -> "deadline_exceeded"
        is CancellationException -> "cancelled"
        is org.json.JSONException, is IllegalArgumentException -> "invalid_argument"
        else -> "transport_error"
      }
      JSONObject().put("success", false).put("code", code).toString()
    }
  }

  private suspend fun connect(id: String, options: Options): JSONObject {
    val entry = synchronized(lock) {
      if (disposed) throw SafeError("closed")
      if (streams.containsKey(id)) throw SafeError("invalid_argument")
      if (streams.size >= 128) throw SafeError("resource_exhausted")
      Entry(scope.async(start = CoroutineStart.LAZY) { dial(id, options) }).also { streams[id] = it }
    }
    var carrier: Carrier? = null
    try {
      val connected = select<Carrier> { entry.task.onAwait { it }; entry.cancelled.onAwait { throw SafeError("cancelled") } }
      carrier = connected
      synchronized(lock) {
        if (disposed || streams[id] !== entry) throw SafeError("cancelled")
        entry.carrier = carrier
      }
      options.expiry?.let { expiry ->
        entry.expiry = scope.launch { delay((expiry - System.currentTimeMillis()).coerceAtLeast(0)); abort(id) }
      }
      return JSONObject().put("remoteEndpointId", connected.remoteEndpointId)
    } catch (error: Exception) { carrier?.abort(); abort(id); throw error }
  }

  private suspend fun dial(id: String, options: Options): Carrier = withTimeout(30000) {
    val address = try { EndpointTicket.fromString(options.ticket).endpointAddr() } catch (_: Exception) { throw SafeError("invalid_argument") }
    if (address.id().toString() != options.endpointId) throw SafeError("identity_mismatch")
    var lease: Lease? = null
    var connection: Connection? = null
    try {
      val own = acquire(options.key ?: "ephemeral:$id", options)
      lease = own
      if (options.token != null) options.urls!!.forEach { own.endpoint.insertRelay(RelayConfig(it, authToken = options.token)) }
      val connected = own.endpoint.connect(address, "linkspan/iroh-noise/1".toByteArray(Charsets.UTF_8))
      connection = connected
      if (connected.remoteId().toString() != options.endpointId) throw SafeError("identity_mismatch")
      connected.setMaxConcurrentBiStreams(1uL)
      connected.setMaxConcurrentUniStreams(0uL)
      connected.setReceiveWindow(524288uL)
      val bi = connected.openBi()
      currentCoroutineContext().ensureActive()
      Carrier(connected, bi, own)
    } catch (error: Exception) {
      connection?.let { runCatching { it.close(1, byteArrayOf()) } }
      withContext(NonCancellable) { lease?.release() }
      throw error
    }
  }

  private suspend fun acquire(key: String, options: Options): Lease {
    val entry = synchronized(lock) {
      if (disposed) throw SafeError("closed")
      var entry = endpoints[key]
      if (entry != null && entry.configuration != options.urls) throw SafeError("invalid_argument")
      if (entry == null) {
        if (endpoints.size >= 128) throw SafeError("resource_exhausted")
        lateinit var created: PoolEntry
        val task = scope.async(start = CoroutineStart.LAZY) {
          beforeBind()
          val builder = EndpointBuilder()
          if (options.urls?.isEmpty() == true) builder.applyMinimal() else builder.applyN0()
          builder.alpns(listOf("linkspan/iroh-noise/1".toByteArray(Charsets.UTF_8)))
          options.key?.let { builder.secretKey(unhex(it)) }
          options.urls?.let { urls ->
            if (urls.isEmpty()) builder.relayMode(RelayMode.disabled())
            else {
              val map = RelayMap.empty()
              urls.forEach { map.insert(RelayConfig(it, authToken = options.token)) }
              builder.relayMode(RelayMode.custom(map))
            }
          }
          val endpoint = builder.bind()
          if (created.ended.get()) { endpoint.shutdown(); throw CancellationException() }
          endpoint
        }
        created = PoolEntry(task, options.urls)
        entry = created
        endpoints[key] = created
      }
      entry.references++
      entry
    }
    try { return Lease(entry.task.await(), key, entry) }
    catch (error: Exception) {
      val last = synchronized(lock) { entry.references--; if (entry.references == 0) { if (endpoints[key] === entry) endpoints.remove(key); true } else false }
      if (last) { entry.ended.set(true); entry.task.cancel() }
      throw error
    }
  }

  private suspend fun closeEndpoint(entry: PoolEntry, endpoint: Endpoint) {
    if (entry.ended.compareAndSet(false, true)) runCatching { withTimeout(5000) { endpoint.shutdown() } }
  }
  private fun abort(id: String) {
    val entry = synchronized(lock) { streams.remove(id) } ?: return
    entry.cancelled.complete(Unit)
    entry.expiry?.cancel()
    entry.carrier?.abort()
    entry.task.cancel()
    scope.launch { runCatching { entry.task.await() }.getOrNull()?.abort() }
  }
  suspend fun dispose() {
    val old = synchronized(lock) { if (disposed) return; disposed = true; streams.keys.toList() }
    old.forEach { abort(it) }
    val pending = synchronized(lock) { endpoints.values.toList().also { endpoints.clear() } }
    pending.forEach { entry ->
      if (entry.task.isCompleted && !entry.task.isCancelled) runCatching { closeEndpoint(entry, entry.task.await()) }
      else { entry.ended.set(true); entry.task.cancel() }
    }
    scope.cancel()
  }

  private fun options(value: JSONObject): Options {
    val ticket = value.optString("ticket"); val id = value.optString("expectedEndpointId")
    val key = if (value.has("clientKey") && !value.isNull("clientKey")) value.getString("clientKey") else null
    val token = if (value.has("relayToken") && !value.isNull("relayToken")) value.getString("relayToken") else null
    val urls = value.optJSONArray("relayUrls")?.let { array ->
      if (array.length() !in 0..8) throw SafeError("invalid_argument")
      (0 until array.length()).map { index ->
        val url = array.getString(index)
        val parsed = URI(url)
        if (url.length > 2048 || parsed.scheme != "https" || parsed.host.isNullOrEmpty() || parsed.rawUserInfo != null || parsed.rawQuery != null || parsed.rawFragment != null) throw SafeError("invalid_argument")
        url
      }
    }
    val expiry = if (value.has("relayTokenExpiresAt") && !value.isNull("relayTokenExpiresAt")) value.getLong("relayTokenExpiresAt") else null
    if (ticket.length !in 16..8192 || !id.matches(Regex("[0-9a-f]{64}")) || (key != null && !key.matches(Regex("[0-9a-f]{64}")))) throw SafeError("invalid_argument")
    if (token != null && (token.length !in 1..16384 || token.any { it == '\r' || it == '\n' || it == '\u0000' } || key == null || urls.isNullOrEmpty() || expiry == null || expiry <= System.currentTimeMillis() || expiry > System.currentTimeMillis() + 86400000)) throw SafeError("invalid_argument")
    return Options(ticket, id, key, urls, token, expiry)
  }
  private fun bytes(values: JSONArray): ByteArray {
    if (values.length() > 131072) throw SafeError("resource_exhausted")
    return ByteArray(values.length()) { index ->
      val value = values.get(index)
      if (value !is Number || value.toDouble() % 1.0 != 0.0 || value.toDouble() !in 0.0..255.0) throw SafeError("invalid_argument")
      value.toInt().toByte()
    }
  }
  private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it.toInt() and 255) }
  private fun unhex(value: String) = ByteArray(32) { value.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
}

package app.joko.linkspan

import computer.iroh.Endpoint
import computer.iroh.EndpointAddr
import computer.iroh.EndpointId
import computer.iroh.EndpointOptions
import computer.iroh.EndpointTicket
import computer.iroh.RelayMode
import computer.iroh.presetMinimal
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONArray
import org.json.JSONObject

private suspend fun rpc(engine: LinkspanIrohEngine, method: String, id: String, args: Any? = null): JSONObject {
  val reply = JSONObject(engine.request(JSONObject().put("method", method).put("streamId", id).put("args", args ?: JSONObject.NULL).toString()))
  check(reply.optBoolean("success")) { "Native RPC failed with safe code: ${reply.optString("code")}" }
  return reply
}
private fun buffer(vararg values: Int) = JSONArray().apply { values.forEach { put(it) } }

fun main() = runBlocking {
  withTimeout(20000) {
    val alpn = "linkspan/iroh-noise/1".toByteArray(Charsets.UTF_8)
    val server = Endpoint.bind(EndpointOptions(preset = presetMinimal(), relayMode = RelayMode.disabled(), alpns = listOf(alpn)))
    val engine = LinkspanIrohEngine()
    val identity = rpc(engine, "identity", "0".repeat(32)).getJSONObject("value")
    check(identity.getString("privateKey").matches(Regex("[0-9a-f]{64}")))
    val ticket = EndpointTicket.fromAddr(server.addr()).toString()
    val options = JSONObject().put("ticket", ticket).put("expectedEndpointId", server.id().toString()).put("clientKey", identity.getString("privateKey")).put("relayUrls", JSONArray())
    val ids = listOf("1".repeat(32), "2".repeat(32))
    val peerIdentities = mutableListOf<String>()
    val peers = launch {
      coroutineScope {
        repeat(2) {
          val connection = server.acceptNext()!!.accept().connect()
          peerIdentities.add(connection.remoteId().toString())
          launch {
            try {
              val stream = connection.acceptBi()
              while (true) {
                val bytes = stream.recv().read(65536u)
                if (bytes.isEmpty()) break
                stream.send().writeAll(bytes)
              }
            } catch (_: Exception) { /* A different stream can close independently. */ }
            finally { runCatching { connection.close(0, byteArrayOf()) } }
          }
        }
      }
    }
    try {
      for ((index, id) in ids.withIndex()) {
        check(rpc(engine, "connect", id, options).getJSONObject("value").getString("remoteEndpointId") == server.id().toString())
        rpc(engine, "write", id, buffer(index, 0, 255))
        check(rpc(engine, "read", id).getJSONArray("value").toString() == buffer(index, 0, 255).toString())
      }
      check(peerIdentities.size == 2 && peerIdentities.all { it == identity.getString("publicKey") })
      rpc(engine, "close", ids[0])
      rpc(engine, "write", ids[1], buffer(4, 255, 1))
      check(rpc(engine, "read", ids[1]).getJSONArray("value").toString() == buffer(4, 255, 1).toString())
      val mismatch = JSONObject(options.toString()).put("expectedEndpointId", "a".repeat(64))
      val rejected = JSONObject(engine.request(JSONObject().put("method", "connect").put("streamId", "3".repeat(32)).put("args", mismatch).toString()))
      check(!rejected.optBoolean("success") && rejected.optString("code") == "identity_mismatch")
      val hangingAddress = EndpointAddr(EndpointId.fromString(identity.getString("publicKey")), null, listOf("127.0.0.1:9"))
      val hanging = JSONObject().put("ticket", EndpointTicket.fromAddr(hangingAddress).toString()).put("expectedEndpointId", identity.getString("publicKey")).put("relayUrls", JSONArray())
      val pending = async { engine.request(JSONObject().put("method", "connect").put("streamId", "4".repeat(32)).put("args", hanging).toString()) }
      kotlinx.coroutines.delay(100)
      rpc(engine, "abort", "4".repeat(32))
      val cancelled = JSONObject(withTimeout(2000) { pending.await() })
      check(!cancelled.optBoolean("success") && cancelled.optString("code") == "cancelled")
      rpc(engine, "close", ids[1])
      engine.dispose()
      val retired = JSONObject(engine.request(JSONObject().put("method", "identity").put("streamId", "0".repeat(32)).toString()))
      check(!retired.optBoolean("success") && retired.optString("code") == "closed")
      val resumed = LinkspanIrohEngine()
      rpc(resumed, "identity", "0".repeat(32)); resumed.dispose()
      println("Native Kotlin engine: actual SDK UDP identity, pin mismatch, binary I/O, concurrent owner release, cancellation, disposal/recreation passed")
    } finally { engine.dispose(); server.shutdown(); peers.cancelAndJoin() }
  }
}

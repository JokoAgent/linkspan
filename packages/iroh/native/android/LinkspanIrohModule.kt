package app.joko.linkspan

import android.os.Build
import computer.iroh.IrohAndroid
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.functions.Coroutine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import org.json.JSONObject

class LinkspanIrohModule : Module() {
  private val lock = Any()
  private var engine: LinkspanIrohEngine? = null
  @Volatile private var destroyed = false
  private var retiring: Deferred<Unit>? = null
  private val supported: Boolean get() = Build.VERSION.SDK_INT >= 24 && Build.SUPPORTED_ABIS.any { it in BuildConfig.LINKSPAN_IROH_ABIS.split(',') }
  private val cleanup = CoroutineScope(SupervisorJob() + Dispatchers.IO)
  private suspend fun current(allowCreate: Boolean): LinkspanIrohEngine? {
    while (true) {
      val previous = synchronized(lock) {
        if (destroyed || !supported || !allowCreate && engine == null) return null
        retiring
      }
      previous?.await()
      var changed = false
      val value = synchronized(lock) {
        if (retiring !== previous) { changed = true; null }
        else if (destroyed || !supported) null
        else engine ?: if (!allowCreate) null else LinkspanIrohEngine {
          IrohAndroid.installAndroidContext(requireNotNull(appContext.reactContext).applicationContext)
        }.also { engine = it }
      }
      if (!changed) return value
    }
  }
  private fun retire(destroy: Boolean = false): Deferred<Unit>? = synchronized(lock) {
    if (destroy) destroyed = true
    val old = engine
    engine = null
    if (old == null) return retiring
    val previous = retiring
    cleanup.async(start = CoroutineStart.LAZY) { previous?.await(); old.dispose() }.also { retiring = it; it.start() }
  }
  override fun definition() = ModuleDefinition {
    Name("LinkspanIroh")
    Function("isAvailable") { !destroyed && supported }
    AsyncFunction("request") Coroutine { request: String ->
      try {
        if (request.length > 800000) "{\"success\":false,\"code\":\"resource_exhausted\"}"
        else {
          val method = runCatching { JSONObject(request).optString("method") }.getOrNull()
          current(method == "connect" || method == "identity")?.request(request) ?: "{\"success\":false,\"code\":\"closed\"}"
        }
      }
      catch (_: Throwable) { "{\"success\":false,\"code\":\"unavailable\"}" }
    }
    AsyncFunction("dispose") Coroutine { -> retire()?.await(); Unit }
    OnDestroy {
      val pending = retire(destroy = true)
      if (pending == null) cleanup.cancel() else pending.invokeOnCompletion { cleanup.cancel() }
    }
  }
}

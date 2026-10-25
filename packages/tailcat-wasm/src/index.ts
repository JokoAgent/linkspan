import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import type { LinkspanErrorCode, OperationOptions } from "@jokoagent/linkspan-core";
import { createTailcatRuntimeFromRpc } from "@jokoagent/linkspan-tailcat-runtime";
import "./runtime/wasm_exec.js";

interface GoRuntime { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> }
declare global {
  var Go: new () => GoRuntime;
  var linkspanTailcatRequest: ((request: string) => Promise<string>) | undefined;
}

let suppliedBytes: Uint8Array | undefined;
let initialized: Promise<void> | undefined;
let sequence = 0;
export function configureTailcatWasm(bytes: Uint8Array) {
  if (initialized) throw new LinkspanError("invalid_argument", "The WASM runtime is already initialized");
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > 64 * 1024 * 1024) throw new LinkspanError("invalid_argument", "A bounded, application-bundled WASM module is required");
  suppliedBytes = bytes.slice();
}

async function initialize() {
  const go = new globalThis.Go();
  const bytes = suppliedBytes ?? await (async () => {
    const response = await fetch(new URL("./runtime/tailcat.wasm", import.meta.url));
    if (!response.ok) throw new LinkspanError("unavailable", "The application's bundled tailcat WASM module is unavailable");
    const result = new Uint8Array(await response.arrayBuffer());
    if (result.length > 64 * 1024 * 1024) throw new LinkspanError("resource_exhausted", "The bundled WASM module exceeds its size limit");
    return result;
  })();
  const result = await WebAssembly.instantiate(bytes as BufferSource, go.importObject);
  const scope = createOperationScope({ deadline: Date.now() + 10_000 });
  let failed = false;
  void go.run(result.instance).catch(() => { failed = true; });
  try {
    while (typeof globalThis.linkspanTailcatRequest !== "function") {
      scope.check();
      if (failed) throw new LinkspanError("unavailable", "The bundled tailcat WASM runtime failed to start");
      await scope.wait(new Promise<void>(resolve => setTimeout(resolve, 1)));
    }
  } finally { scope.dispose(); }
}

export async function createTailcatRuntime() {
  initialized ??= initialize();
  await initialized;
  async function request(method: string, args: Record<string, unknown>, options: OperationOptions = {}) {
    const scope = createOperationScope(options);
    const requestId = ++sequence;
    let sent = false;
    const cancel = () => {
      if (sent) void globalThis.linkspanTailcatRequest?.(JSON.stringify({ id: ++sequence, method: "cancel", args: { cancelId: requestId } })).catch(() => {});
    };
    scope.signal.addEventListener("abort", cancel, { once: true });
    try {
      scope.check();
      sent = true;
      const pending = globalThis.linkspanTailcatRequest!(JSON.stringify({ id: requestId, method, args, ...(options.deadline === undefined ? {} : { deadline: options.deadline }) })).then(text => {
        if (text.length > 512 * 1024) throw new LinkspanError("resource_exhausted", "The binding reply exceeds its size limit");
        const reply = JSON.parse(text) as { result: unknown; error?: string };
        if (reply.error) {
          const known = ["invalid_argument","identity_mismatch","closed","cancelled","deadline_exceeded","resource_exhausted","transport_error"];
          throw new LinkspanError(known.includes(reply.error) ? reply.error as LinkspanErrorCode : "transport_error", "The tailcat WASM operation failed");
        }
        if (scope.signal.aborted && (method === "connect" || method === "listen") && typeof (reply.result as { handle?: unknown })?.handle === "string") {
          void request(method === "connect" ? "abort" : "closeListener", { handle: (reply.result as { handle: string }).handle }).catch(() => {});
        }
        return reply.result;
      });
      return await scope.wait(pending);
    } catch (error) { cancel(); throw asLinkspanError(error); }
    finally { scope.signal.removeEventListener("abort", cancel); scope.dispose(); }
  }
  return createTailcatRuntimeFromRpc(request);
}

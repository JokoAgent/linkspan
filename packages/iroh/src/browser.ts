import { createIrohApi } from "./common.js";
import { createStreamBridgeHost } from "@jokoagent/linkspan-core/stream";
import type { IrohConnectOptions } from "./types.js";
import { LinkspanError } from "@jokoagent/linkspan-core";
let loaded: ReturnType<typeof import("@jokoagent/linkspan-iroh-wasm")["createIrohRuntime"]> | undefined;
const load = () => loaded ??= import("@jokoagent/linkspan-iroh-wasm").then(module=>module.createIrohRuntime());
export const { connectIroh, listenIroh, createIrohIdentity } = createIrohApi(load);
/** Only trusted, application-bundled bytes may be supplied by a native host. */
export async function initializeIrohWasm(bytes: Uint8Array): Promise<void> {
  if (loaded) throw new Error("The iroh runtime is already initialized");
  (await import("@jokoagent/linkspan-iroh-wasm")).configureIrohWasm(bytes);
}
export function createIrohBridgeHost() {
  let disposed=false;
  const host = createStreamBridgeHost(async (args, options) => {
    const config = args as Omit<IrohConnectOptions,"identity"|"expectedPublicKey">;
    return (await load()).connect({ ...config, ...options });
  });
  return {
    dispose(){disposed=true;host.dispose();},
    async request(message:import("@jokoagent/linkspan-core/stream").StreamBridgeRequest){
      if(disposed)throw new LinkspanError("closed","The local SDK bridge is closed");
      if(message?.method!=="identity")return host.request(message);
      if(!/^[0-9a-f]{32}$/u.test(message.streamId))throw new LinkspanError("invalid_argument","Invalid bridge stream identifier");
      const identity=await(await load()).generateIdentity();if(disposed)throw new LinkspanError("closed","The local SDK bridge is closed");return identity;
    },
  };
}
export { IROH_LIMITS } from "./common.js";
export type * from "./types.js";

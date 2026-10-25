import { createTailcatApi } from "./common.js";
import { createStreamBridgeHost } from "@jokoagent/linkspan-core/stream";
import type { TailcatConnectOptions } from "./types.js";
import { LinkspanError } from "@jokoagent/linkspan-core";
let loaded: ReturnType<typeof import("@jokoagent/linkspan-tailcat-wasm")["createTailcatRuntime"]> | undefined;
const load = () => loaded ??= import("@jokoagent/linkspan-tailcat-wasm").then(module=>module.createTailcatRuntime());
export const { connectTailcat, listenTailcat, createTailcatIdentity } = createTailcatApi(load);
export async function initializeTailcatWasm(bytes: Uint8Array): Promise<void> {
  if (loaded) throw new Error("The tailcat runtime is already initialized");
  (await import("@jokoagent/linkspan-tailcat-wasm")).configureTailcatWasm(bytes);
}
export function createTailcatBridgeHost() {
  let disposed=false;
  const host = createStreamBridgeHost(async (args, options) => {
    const config = args as Omit<TailcatConnectOptions, "identity" | "expectedPublicKey">;
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
export { TAILCAT_LIMITS } from "./common.js";
export type * from "./types.js";

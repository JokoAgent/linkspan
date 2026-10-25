import { createIrohApi,validateIrohOptions } from "./common.js";
import { LinkspanError } from "@jokoagent/linkspan-core";
import { createStreamBridgeHost } from "@jokoagent/linkspan-core/stream";
import type { StreamBridgeRequest } from "@jokoagent/linkspan-core/stream";
import type { IrohConnectOptions } from "./types.js";
let loaded: ReturnType<typeof import("@jokoagent/linkspan-iroh-node")["createIrohRuntime"]> | undefined;
const load = () => loaded ??= import("@jokoagent/linkspan-iroh-node").then(module=>module.createIrohRuntime());
export const { connectIroh, listenIroh, createIrohIdentity } = createIrohApi(load);
/** A distinct host for one trusted renderer/profile. Its streams retain shared SDK leases. */
export function createIrohBridgeHost() {
  let disposed=false;
  const host=createStreamBridgeHost(async(args,options)=>{
    const config=args as Omit<IrohConnectOptions,"identity"|"expectedPublicKey">;
    validateIrohOptions({...config,expectedPublicKey:`ed25519:${"0".repeat(64)}`});
    return (await load()).connect({...config,...options});
  });
  return {
    dispose(){disposed=true;host.dispose();},
    async request(message:StreamBridgeRequest){
      if(disposed)throw new LinkspanError("closed","The local SDK bridge is closed");
      if(message?.method!=="identity")return host.request(message);
      if(!/^[0-9a-f]{32}$/u.test(message.streamId))throw new LinkspanError("invalid_argument","Invalid bridge stream identifier");
      const identity=await(await load()).generateIdentity();
      if(disposed)throw new LinkspanError("closed","The local SDK bridge is closed");
      return identity;
    },
  };
}
export { IROH_LIMITS } from "./common.js";
export type * from "./types.js";

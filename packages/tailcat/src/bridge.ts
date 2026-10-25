import { LinkspanError } from "@jokoagent/linkspan-core";
import { connectStreamBridge } from "@jokoagent/linkspan-core/stream";
import type { StreamBridge } from "@jokoagent/linkspan-core/stream";
import { createTailcatApi } from "./common.js";
let bridge: StreamBridge | undefined;
export function createTailcatBridgeClient(value:StreamBridge){return createTailcatApi(async()=>bridgeRuntime(()=>value));}
export function installTailcatBridge(value: StreamBridge): () => void {
  bridge = value;
  return () => { if (bridge === value) bridge = undefined; };
}
function bridgeRuntime(current:()=>StreamBridge|undefined){return {
  async generateIdentity() {
    const selected=current();
    if (!selected) throw new LinkspanError("unavailable", "The application's trusted tailcat bridge is unavailable");
    const identity=await selected.request({method:"identity",streamId:"0".repeat(32)}) as import("@jokoagent/linkspan-tailcat-runtime").TailcatIdentity;
    if(!identity||!/^privkey:[0-9a-f]{64}$/u.test(identity.privateKey)||!/^nodekey:[0-9a-f]{64}$/u.test(identity.publicKey)||!/^psk:[0-9a-f]{64}$/u.test(identity.presharedKey))throw new LinkspanError("protocol_error","The trusted bridge returned an invalid identity");
    return identity;
  },
  async connect(options:Parameters<import("./types.js").TailcatRuntime["connect"]>[0]) {
    const selected=current();
    if (!selected) throw new LinkspanError("unavailable", "The application's trusted tailcat bridge is unavailable");
    return connectStreamBridge(selected, { address: options.address, expectedEndpointId: options.expectedEndpointId, port: options.port, ...(options.clientKey === undefined ? {} : { clientKey: options.clientKey }),...(options.derpMapUrl===undefined?{}:{derpMapUrl:options.derpMapUrl}) }, options);
  },
  async listen() { throw new LinkspanError("unavailable", "Application server listeners use the server runtime"); },
};}
export const { connectTailcat, createTailcatIdentity } = createTailcatApi(async () => bridgeRuntime(()=>bridge));
export { TAILCAT_LIMITS } from "./common.js";
export type * from "./types.js";

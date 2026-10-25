import { LinkspanError } from "@jokoagent/linkspan-core";
import { connectStreamBridge } from "@jokoagent/linkspan-core/stream";
import type { StreamBridge } from "@jokoagent/linkspan-core/stream";
import { createIrohApi } from "./common.js";
let bridge: StreamBridge | undefined;
/** Bind a connection to one trusted host, so native and relay profiles coexist. */
export function createIrohBridgeClient(value:StreamBridge) {
  return createIrohApi(async()=>bridgeRuntime(()=>value));
}
/** Install only a host-owned bridge to the trusted, bundled local WebView. */
export function installIrohBridge(value: StreamBridge): () => void {
  bridge = value;
  return () => { if (bridge === value) bridge = undefined; };
}
function bridgeRuntime(current:()=>StreamBridge|undefined){return {
  async generateIdentity() {
    const selected=current();
    if (!selected) throw new LinkspanError("unavailable", "The application's trusted iroh bridge is unavailable");
    const identity=await selected.request({method:"identity",streamId:"0".repeat(32)}) as import("./types.js").IrohIdentity;
    if(!identity||!/^[0-9a-f]{64}$/u.test(identity.privateKey)||!/^[0-9a-f]{64}$/u.test(identity.publicKey))throw new LinkspanError("protocol_error","The trusted bridge returned an invalid identity");
    return identity;
  },
  async connect(options:Parameters<import("./types.js").IrohRuntime["connect"]>[0]) {
    const selected=current();
    if (!selected) throw new LinkspanError("unavailable", "The application's trusted iroh bridge is unavailable");
    return connectStreamBridge(selected, { ticket: options.ticket, expectedEndpointId: options.expectedEndpointId,clientKey:options.clientKey,relayUrls:options.relayUrls,relayToken:options.relayToken,relayTokenExpiresAt:options.relayTokenExpiresAt }, options);
  },
  async listen() { throw new LinkspanError("unavailable", "Application server listeners use the server runtime"); },
};}
export const { connectIroh, createIrohIdentity } = createIrohApi(async () => bridgeRuntime(()=>bridge));
export { IROH_LIMITS } from "./common.js";
export type * from "./types.js";

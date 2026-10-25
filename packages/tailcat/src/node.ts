import { createTailcatApi,validateTailcatOptions } from "./common.js";
import { LinkspanError,createOperationScope } from "@jokoagent/linkspan-core";
import { createStreamBridgeHost } from "@jokoagent/linkspan-core/stream";
import type { StreamBridgeRequest } from "@jokoagent/linkspan-core/stream";
import type { TailcatConnectOptions } from "./types.js";
let shared:ReturnType<typeof import("@jokoagent/linkspan-tailcat-node")["createTailcatRuntime"]>|undefined;
let owners=0;
const load=async()=>{
  const pending=shared??=import("@jokoagent/linkspan-tailcat-node").then(module=>module.createTailcatRuntime());owners++;
  try{const runtime=await pending;let released=false;return{...runtime,dispose(){if(released)return;released=true;owners--;if(owners===0&&shared===pending){shared=undefined;runtime.dispose?.();}}};}
  catch(error){owners--;if(shared===pending)shared=undefined;throw error;}
};
export const { connectTailcat, listenTailcat, createTailcatIdentity } = createTailcatApi(load);
/** One renderer/profile owns only its channels, including its helper owner references. */
export function createTailcatBridgeHost() {
  let disposed=false;
  const host=createStreamBridgeHost(async(args,options)=>{
    const config=args as Omit<TailcatConnectOptions,"identity"|"expectedPublicKey">;
    validateTailcatOptions({...config,expectedPublicKey:`ed25519:${"0".repeat(64)}`});
    const scope=createOperationScope(options);
    let runtime:Awaited<ReturnType<typeof load>>|undefined;
    let released=false;const release=()=>{if(!released){released=true;runtime?.dispose();}};
    let stream:Awaited<ReturnType<NonNullable<typeof runtime>["connect"]>>|undefined;
    try{
      const owner=await scope.wait(load().then(value=>{if(scope.signal.aborted)value.dispose();return value;}));runtime=owner;
      const carrier=await owner.connect({...config,...options});stream=carrier;scope.check();
      return {
        remoteEndpointId:carrier.remoteEndpointId,
        async read(){try{return await carrier.read();}catch(error){carrier.abort();release();throw error;}},
        async write(bytes:Uint8Array){try{await carrier.write(bytes);}catch(error){carrier.abort();release();throw error;}},
        async close(){try{await carrier.close();}finally{release();}},
        abort(reason?:unknown){try{carrier.abort(reason);}finally{release();}},
      };
    }catch(error){stream?.abort();release();throw error;}
    finally{scope.dispose();}
  });
  return {
    dispose(){disposed=true;host.dispose();},
    async request(message:StreamBridgeRequest){
      if(disposed)throw new LinkspanError("closed","The local SDK bridge is closed");
      if(message?.method!=="identity")return host.request(message);
      if(!/^[0-9a-f]{32}$/u.test(message.streamId))throw new LinkspanError("invalid_argument","Invalid bridge stream identifier");
      const runtime=await load();
      try{const identity=await runtime.generateIdentity();if(disposed)throw new LinkspanError("closed","The local SDK bridge is closed");return identity;}
      finally{runtime.dispose();}
    },
  };
}
export { TAILCAT_LIMITS } from "./common.js";
export type * from "./types.js";

import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import type { OperationOptions } from "@jokoagent/linkspan-core";
import { acceptStream, connectStream } from "@jokoagent/linkspan-noise";
import type { TailcatConnectOptions, TailcatListenOptions, TailcatListener, TailcatRuntime } from "./types.js";

export const TAILCAT_LIMITS = Object.freeze({ experimental: true, upstreamVersion: "0.7.0", browserRelayOnly: true, publicRelayHasSla: false, addressContainsSecret: true, wireApiStable: false });
export function validateTailcatOptions(options: TailcatConnectOptions) {
  if (!/^ed25519:[0-9a-f]{64}$/u.test(options.expectedPublicKey) || !/^nodekey:[0-9a-f]{64}$/u.test(options.expectedEndpointId)
    || typeof options.address !== "string" || !/^tc[A-Za-z0-9_-]+$/u.test(options.address) || options.address.length > 8192
    || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new LinkspanError("invalid_argument", "A trusted application key, tailcat endpoint id, private address and port are required");
  }
}

export function createTailcatApi(load: () => Promise<TailcatRuntime>) {
  return {
    async createTailcatIdentity() {
      const runtime = await load();
      try { return await runtime.generateIdentity(); }
      finally { runtime.dispose?.(); }
    },
    async connectTailcat(options: TailcatConnectOptions) {
      validateTailcatOptions(options);
      const scope = createOperationScope({...options,deadline:Math.min(options.deadline??Infinity,Date.now()+30000)});
      let stream: Awaited<ReturnType<TailcatRuntime["connect"]>> | undefined;
      let runtime: TailcatRuntime | undefined;
      const cancel = () => stream?.abort(scope.signal.reason);
      scope.signal.addEventListener("abort", cancel, { once: true });
      try {
        scope.check();
        const loadedRuntime: TailcatRuntime = await scope.wait(load().then(value => { if (scope.signal.aborted) value.dispose?.(); return value; }));
        runtime = loadedRuntime;
        stream = await scope.wait(loadedRuntime.connect({ address: options.address, expectedEndpointId: options.expectedEndpointId, port: options.port, ...(options.clientKey === undefined ? {} : { clientKey: options.clientKey }),...(options.derpMapUrl===undefined?{}:{derpMapUrl:options.derpMapUrl}), signal: scope.signal, ...(options.deadline === undefined ? {} : { deadline: options.deadline }) }));
        scope.check();
        if (stream.remoteEndpointId !== options.expectedEndpointId) throw new LinkspanError("identity_mismatch", "The tailcat endpoint identity did not match the trusted endpoint");
        const channel = await connectStream(stream, options);
        const owner = loadedRuntime;
        void channel.closed.then(() => owner.dispose?.());
        return channel;
      } catch (error) { stream?.abort(error); runtime?.dispose?.(); throw asLinkspanError(error); }
      finally { scope.signal.removeEventListener("abort", cancel); scope.dispose(); }
    },
    async listenTailcat(options: TailcatListenOptions): Promise<TailcatListener> {
      if (!options.identity || !/^ed25519:[0-9a-f]{64}$/u.test(options.identity.publicKey) || !Array.isArray(options.allowedClients)
        || (options.allowedClients.length === 0 && options.allowPrivateAddressPairing !== true)
        || options.allowedClients.some(key => !/^nodekey:[0-9a-f]{64}$/u.test(key))) {
        throw new LinkspanError("invalid_argument", "A host-owned identity and explicit client allowlist or private-address pairing approval are required");
      }
      const scope = createOperationScope(options);
      let owner:TailcatRuntime|undefined;
      try {
        scope.check();
        const runtime:TailcatRuntime = await scope.wait(load().then(value=>{if(scope.signal.aborted)value.dispose?.();return value;}));
        owner=runtime;
        const listener = await scope.wait(runtime.listen({...options,deadline:Math.min(options.deadline??Infinity,Date.now()+30000)}));
        let closing:Promise<void>|undefined;
        const ownerAbort=()=>{void close().catch(()=>{});};
        const close=()=>closing??=(async()=>{options.signal?.removeEventListener("abort",ownerAbort);try{await listener.close();}finally{runtime.dispose?.();}})();
        options.signal?.addEventListener("abort",ownerAbort,{once:true});scope.check();
        return {
          address: listener.address, endpointId: listener.endpointId, port: listener.port,
          async accept(acceptOptions:OperationOptions = {}) {
            const attempt=createOperationScope(acceptOptions);
            try{
              for(;;){
                attempt.check();
                const carrier=await listener.accept(acceptOptions);
                if(carrier===null)return null;
                try{return await acceptStream(carrier,{...acceptOptions,deadline:Math.min(acceptOptions.deadline??Infinity,Date.now()+10000),identity:options.identity});}
                catch(error){carrier.abort(error);attempt.check();const code=asLinkspanError(error).code;if(!["authentication_failed","identity_mismatch","protocol_error","closed","transport_error","resource_exhausted","deadline_exceeded"].includes(code))throw error;await attempt.wait(new Promise<void>(resolve=>setTimeout(resolve,10)));}
              }
            }finally{attempt.dispose();}
          },
          close,
        };
      } catch(error){owner?.dispose?.();throw error;}
      finally { scope.dispose(); }
    },
  };
}

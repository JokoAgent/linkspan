import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import type { OperationOptions } from "@jokoagent/linkspan-core";
import { acceptStream, connectStream } from "@jokoagent/linkspan-noise";
import type { IrohConnectOptions, IrohListenOptions, IrohListener, IrohRuntime } from "./types.js";

export const IROH_LIMITS = Object.freeze({ experimental: false, browserRelayOnly: true, macosIntelNodeRequiresSourceBuild: true, publicRelayHasSla: false, automaticPaidUpgrade: false, maxRelayLeaseSeconds:86400, nodeUpstreamVersion: "1.2.0", wasmUpstreamVersion: "1.4.1",servicesUpstreamVersion:"1.0.0" });
export function validateIrohOptions(options: IrohConnectOptions) {
  if (!/^ed25519:[0-9a-f]{64}$/u.test(options.expectedPublicKey) || !/^[0-9a-f]{64}$/u.test(options.expectedEndpointId)
    || typeof options.ticket !== "string" || options.ticket.length < 16 || options.ticket.length > 8192) {
    throw new LinkspanError("invalid_argument", "A trusted application key, iroh endpoint id and bounded ticket are required");
  }
  if (options.clientKey !== undefined && !/^[0-9a-f]{64}$/u.test(options.clientKey)) throw new LinkspanError("invalid_argument", "A complete local iroh private key is required");
  if (options.relayUrls !== undefined && (options.relayUrls.length > 8 || options.relayUrls.some(value => {
    try { const url=new URL(value); return url.protocol!=="https:" || !!url.username || !!url.password || !!url.search || !!url.hash; } catch { return true; }
  }))) throw new LinkspanError("invalid_argument", "At most eight trusted HTTPS relay URLs are allowed; an empty list requires native UDP");
  if (options.relayToken !== undefined && (!options.clientKey || !options.relayUrls?.length || options.relayToken.length < 1 || options.relayToken.length > 16384 || /[\r\n\0]/u.test(options.relayToken)
    || !Number.isFinite(options.relayTokenExpiresAt) || options.relayTokenExpiresAt! <= Date.now() || options.relayTokenExpiresAt! > Date.now()+24*60*60*1000)) {
    throw new LinkspanError("invalid_argument", "A relay lease requires its exact local key, relay URLs and expiry within 24 hours");
  }
}

export function createIrohApi(load: () => Promise<IrohRuntime>) {
  return {
    async createIrohIdentity() {
      const runtime = await load();
      try { return await runtime.generateIdentity(); }
      finally { runtime.dispose?.(); }
    },
    async connectIroh(options: IrohConnectOptions) {
      validateIrohOptions(options);
      const scope = createOperationScope({...options,deadline:Math.min(options.deadline??Infinity,Date.now()+30000)});
      let stream: Awaited<ReturnType<IrohRuntime["connect"]>> | undefined;
      const cancel = () => stream?.abort(scope.signal.reason);
      scope.signal.addEventListener("abort", cancel, { once: true });
      try {
        scope.check();
        const runtime = await scope.wait(load());
        // The runtime owns cancellation while a dial is in progress.
        stream = await scope.wait(runtime.connect({ ticket: options.ticket, expectedEndpointId: options.expectedEndpointId,
          ...(options.clientKey === undefined ? {} : {clientKey:options.clientKey}), ...(options.relayUrls === undefined ? {} : {relayUrls:options.relayUrls}), ...(options.relayToken === undefined ? {} : {relayToken:options.relayToken}), ...(options.relayTokenExpiresAt === undefined ? {} : {relayTokenExpiresAt:options.relayTokenExpiresAt}),
          signal: scope.signal, ...(options.deadline === undefined ? {} : { deadline: options.deadline }) }));
        scope.check();
        if (stream.remoteEndpointId !== options.expectedEndpointId) throw new LinkspanError("identity_mismatch", "The iroh endpoint identity did not match the trusted endpoint");
        return await connectStream(stream, options);
      } catch (error) { stream?.abort(error); throw asLinkspanError(error); }
      finally { scope.signal.removeEventListener("abort", cancel); scope.dispose(); }
    },
    async listenIroh(options: IrohListenOptions): Promise<IrohListener> {
      if (!options.identity || !/^ed25519:[0-9a-f]{64}$/u.test(options.identity.publicKey)) throw new LinkspanError("invalid_argument", "A host-owned application endpoint identity is required");
      if(options.relayToken!==undefined && (options.servicesApiSecret!==undefined || !options.relayUrls?.length || !Number.isFinite(options.relayTokenExpiresAt) || options.relayTokenExpiresAt!<=Date.now() || options.relayTokenExpiresAt!>Date.now()+86400000))throw new LinkspanError("invalid_argument","A relay lease requires an explicit relay and expiry within 24 hours");
      if(options.servicesApiSecret!==undefined && (!options.relayUrls?.length||options.servicesApiSecret.length>16384||!(options.servicesApiSecret.startsWith("services"))))throw new LinkspanError("invalid_argument","A publisher services secret and explicit relay URLs are required");
      const scope = createOperationScope(options);
      try {
        scope.check();
        const runtime = await scope.wait(load());
        const listener = await scope.wait(runtime.listen({...options,deadline:Math.min(options.deadline??Infinity,Date.now()+30000)}));
        return {
          ticket: listener.ticket,
          endpointId: listener.endpointId,
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
          close: () => listener.close(),
        };
      } finally { scope.dispose(); }
    },
  };
}

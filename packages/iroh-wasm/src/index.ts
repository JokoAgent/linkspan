import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import type { OperationOptions, LinkspanErrorCode } from "@jokoagent/linkspan-core";
import type { PeerStream } from "@jokoagent/linkspan-core/stream";
import { createResourcePool } from "@jokoagent/linkspan-core/stream";
interface IrohRuntime {
  generateIdentity():Promise<{privateKey:string;publicKey:string}>;
  connect(options: OperationOptions & {ticket:string;expectedEndpointId:string;clientKey?:string;relayUrls?:readonly string[];relayToken?:string;relayTokenExpiresAt?:number}):Promise<PeerStream>;
  listen(options:OperationOptions & {secretKey?:Uint8Array;relayUrls?:readonly string[];relayToken?:string;relayTokenExpiresAt?:number;servicesApiSecret?:string;servicesTokenTtlSeconds?:number}):Promise<{endpointId:string;ticket:string;accept(options?:OperationOptions):Promise<PeerStream|null>;close():Promise<void>}>;
}
import init, { IrohEndpoint, createIrohIdentity as generateIdentity, issueIrohRelayLease,publicKeyFromPrivate } from "./runtime/linkspan_iroh.js";

let suppliedBytes: Uint8Array | undefined;
let initialized: Promise<unknown> | undefined;
export function configureIrohWasm(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8 || bytes.length > 64 * 1024 * 1024) throw new LinkspanError("invalid_argument", "A bounded, application-bundled WASM module is required");
  if (initialized) {
    if (suppliedBytes?.length === bytes.length && suppliedBytes.every((value,index)=>value===bytes[index])) return;
    throw new LinkspanError("invalid_argument", "The WASM runtime is already initialized with a different module");
  }
  suppliedBytes = bytes.slice();
}
function normalize(error: unknown): LinkspanError {
  const code = error instanceof Error ? error.message : "";
  if (["invalid_argument","identity_mismatch","resource_exhausted","closed","transport_error"].includes(code)) return new LinkspanError(code as LinkspanErrorCode, "The iroh WASM operation failed",{cause:error});
  return asLinkspanError(error);
}
interface WasmStream { remoteEndpointId(): string; read(): Promise<Uint8Array>; write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): void }
function carrier(value: WasmStream, release: () => Promise<void>): PeerStream {
  let ended = false;
  return {
    remoteEndpointId: value.remoteEndpointId(),
    async read() { if (ended) return null; try { const bytes = await value.read(); return bytes.length === 0 ? null : bytes; } catch (error) { throw normalize(error); } },
    async write(bytes) { if (ended) throw new LinkspanError("closed", "The iroh WASM carrier is closed"); try { await value.write(bytes); } catch (error) { throw normalize(error); } },
    async close() { if (!ended) { ended = true; try { await value.close(); } finally { await release(); } } },
    abort() { if (!ended) { ended = true; value.abort(); void release().catch(() => {}); } },
  };
}

export async function createIrohRuntime(): Promise<IrohRuntime> {
  initialized ??= init(suppliedBytes === undefined ? {} : { module_or_path: suppliedBytes });
  await initialized;
  const clients=createResourcePool<IrohEndpoint>(endpoint=>endpoint.close());let ephemeral=0;
  return {
    async generateIdentity() { return JSON.parse(generateIdentity()) as {privateKey:string;publicKey:string}; },
    async connect(options) {
      if(options.relayUrls?.length===0)throw new LinkspanError("unavailable","The selected WASM runtime requires a relay; use a native UDP runtime for direct-only connections");
      const scope = createOperationScope({...options,...(options.relayTokenExpiresAt===undefined?{}:{deadline:Math.min(options.deadline??Infinity,options.relayTokenExpiresAt)})});
      let endpoint: IrohEndpoint | undefined;
      let stream: PeerStream | undefined;
      let expiryTimer:ReturnType<typeof setTimeout>|undefined;
      let releaseEndpoint:(()=>Promise<void>)|undefined;
      let dialing:WasmStream|undefined;
      const cancel = () => {stream?.abort();dialing?.abort();if(releaseEndpoint)void releaseEndpoint().catch(()=>{});};
      scope.signal.addEventListener("abort", cancel, { once: true });
      try {
        scope.check();
        if(options.clientKey!==undefined && !/^[0-9a-f]{64}$/u.test(options.clientKey))throw new LinkspanError("invalid_argument","A complete local backend key is required");
        const secret = options.clientKey===undefined?new Uint8Array():Uint8Array.from(options.clientKey.match(/../gu)!,value=>parseInt(value,16));
        const lease=await clients.acquire(options.clientKey??`ephemeral:${++ephemeral}`,()=>IrohEndpoint.bind(secret,JSON.stringify({relayUrls:options.relayUrls,relayToken:options.relayToken})),{signal:scope.signal,configuration:JSON.stringify(options.relayUrls??null)});
        const own=lease.value;releaseEndpoint=lease.release;
        endpoint=own;
        if(options.relayToken!==undefined)for(const url of options.relayUrls??[])await scope.wait(own.updateRelay(url,options.relayToken));
        const raw = await scope.wait(own.connect(options.ticket, options.expectedEndpointId).then(value=>{if(scope.signal.aborted)value.abort();return value;}));
        dialing=raw;
        stream = carrier(raw, () => {if(expiryTimer!==undefined)clearTimeout(expiryTimer);return lease.release();});
        if(options.relayTokenExpiresAt!==undefined)expiryTimer=setTimeout(()=>{stream?.abort();},Math.max(0,options.relayTokenExpiresAt-Date.now()));
        scope.check();
        return stream;
      } catch (error) {if(expiryTimer!==undefined)clearTimeout(expiryTimer); cancel(); throw normalize(error); }
      finally { scope.signal.removeEventListener("abort", cancel); scope.dispose(); }
    },
    async listen(options) {
      if(options.relayUrls?.length===0)throw new LinkspanError("unavailable","The selected WASM runtime requires a relay; use a native UDP runtime for direct-only listeners");
      const scope = createOperationScope(options);
      let endpoint: IrohEndpoint | undefined;
      let expiryTimer:ReturnType<typeof setTimeout>|undefined;
      let renewalTimer:ReturnType<typeof setTimeout>|undefined;
      const cancel = () => { void endpoint?.close(); };
      scope.signal.addEventListener("abort", cancel, { once: true });
      try {
        scope.check();
        const ttl=options.servicesTokenTtlSeconds??3600;
        let secret=options.secretKey??new Uint8Array();
        let relayToken=options.relayToken;
        let leaseExpiry=options.relayTokenExpiresAt;
        let mint:(()=>{relayToken:string;expiresAt:number})|undefined;
        if(options.servicesApiSecret!==undefined){
          if(!options.relayUrls?.length||options.relayToken!==undefined||!Number.isInteger(ttl)||ttl<60||ttl>86400)throw new LinkspanError("invalid_argument","Publisher relay leases require explicit relays and a bounded TTL");
          let endpointId:string;
          if(secret.length===0){const identity=JSON.parse(generateIdentity()) as {privateKey:string;publicKey:string};secret=Uint8Array.from(identity.privateKey.match(/../gu)!,value=>parseInt(value,16));endpointId=identity.publicKey;}
          else {endpointId=publicKeyFromPrivate(secret);}
          const apiSecret=options.servicesApiSecret;
          mint=()=>JSON.parse(issueIrohRelayLease(apiSecret,endpointId,ttl)) as {relayToken:string;expiresAt:number};
          const lease=mint();relayToken=lease.relayToken;leaseExpiry=lease.expiresAt;
        }
        const own:IrohEndpoint = await scope.wait(IrohEndpoint.bind(secret, JSON.stringify({ relayUrls: options.relayUrls,relayToken })).then(value=>{if(scope.signal.aborted)void value.close();return value;}));
        endpoint=own;
        await scope.wait(own.online());
        const streams = new Set<PeerStream>();
        let ended=false;
        const ownerAbort=()=>{void close();};
        const close = async () => {if(ended)return;ended=true;if(expiryTimer!==undefined)clearTimeout(expiryTimer);if(renewalTimer!==undefined)clearTimeout(renewalTimer);options.signal?.removeEventListener("abort",ownerAbort); for (const stream of streams) stream.abort(); streams.clear(); await own.close(); };
        const scheduleLease=()=>{
          if(leaseExpiry===undefined||ended)return;
          if(expiryTimer!==undefined)clearTimeout(expiryTimer);
          expiryTimer=setTimeout(()=>{void close();},Math.max(0,leaseExpiry-Date.now()));
          if(mint!==undefined)renewalTimer=setTimeout(()=>{void(async()=>{
            try{const lease=mint!();if(ended)return;for(const url of options.relayUrls!){if(ended)return;await own.updateRelay(url,lease.relayToken);}if(ended)return;leaseExpiry=lease.expiresAt;scheduleLease();}catch{await close();}
          })();},Math.max(1,leaseExpiry-Date.now()-Math.min(30000,ttl*100)));
        };
        scheduleLease();options.signal?.addEventListener("abort",ownerAbort,{once:true});
        return {
          endpointId: own.endpointId(), ticket: own.ticket(),
          async accept(acceptOptions: OperationOptions = {}) {
            const attempt = createOperationScope(acceptOptions);
            const cancelAccept = () => { void close(); };
            attempt.signal.addEventListener("abort", cancelAccept, { once: true });
            try {
              const raw = await attempt.wait(own.accept());
              if (raw === undefined) return null;
              let stream: PeerStream;
              stream = carrier(raw, async () => { streams.delete(stream); }); streams.add(stream); return stream;
            } catch (error) { throw normalize(error); }
            finally { attempt.signal.removeEventListener("abort", cancelAccept); attempt.dispose(); }
          },
          close,
        };
      } catch (error) { cancel(); throw normalize(error); }
      finally { scope.signal.removeEventListener("abort", cancel); scope.dispose(); }
    },
  };
}

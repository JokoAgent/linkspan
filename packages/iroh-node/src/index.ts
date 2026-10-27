import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import type { OperationOptions } from "@jokoagent/linkspan-core";
import type { PeerStream } from "@jokoagent/linkspan-core/stream";
import { createResourcePool } from "@jokoagent/linkspan-core/stream";
interface IrohRuntime {
  generateIdentity():Promise<{privateKey:string;publicKey:string}>;
  connect(options: OperationOptions & {ticket:string;expectedEndpointId:string;clientKey?:string;relayUrls?:readonly string[];relayToken?:string;relayTokenExpiresAt?:number}):Promise<PeerStream>;
  listen(options:OperationOptions & {secretKey?:Uint8Array;relayUrls?:readonly string[];relayToken?:string;relayTokenExpiresAt?:number;servicesApiSecret?:string;servicesTokenTtlSeconds?:number}):Promise<{endpointId:string;ticket:string;accept(options?:OperationOptions):Promise<PeerStream|null>;close():Promise<void>}>;
}

const ALPN = Array.from(new TextEncoder().encode("linkspan/iroh-noise/1"));
let configuredDirectory: string | undefined;
/** Configure the build-prepared artifact, before opening any endpoints. */
export function configureIrohRuntime(directory: string) {
  if (!isAbsolute(directory)) throw new LinkspanError("invalid_argument", "The prepared iroh runtime directory must be absolute");
  configuredDirectory = directory;
}

interface Id { toString(): string }
interface Bi {
  send: { writeAll(bytes: number[]): Promise<void>; finish(): Promise<void>; reset(code: bigint): Promise<void> };
  recv: { read(limit: number): Promise<number[]>; stop(code: bigint): Promise<void> };
}
interface Connection {
  remoteId(): Id; openBi(): Promise<Bi>; acceptBi(): Promise<Bi>;
  close(code: bigint, reason: number[]): void;
  setMaxConcurrentBiStreams(count: bigint): void;
  setMaxConcurrentUniStreams(count: bigint): void;
  setReceiveWindow(count: bigint): void;
}
interface Endpoint {
  id(): Id; addr(): unknown; close(): Promise<void>;
  connect(address: unknown, alpn: number[]): Promise<Connection>;
  online(): Promise<void>;
  insertRelay(config:{url:string;authToken?:string}):Promise<void>;
  acceptNext(): Promise<{ accept(): Promise<{ connect(): Promise<Connection> }> } | null>;
}
interface Sdk {
  Endpoint: { builder(): { applyN0(): void; applyMinimal():void; alpns(value: number[][]): void; secretKey(value: number[]): void; relayMode(value: unknown): void; bind(): Promise<Endpoint> } };
  EndpointTicket: { fromString(value: string): { endpointAddr(): { id(): Id } }; fromAddr(value: unknown): { toString(): string } };
  RelayMap: { empty(): { insert(value: { url: string; authToken?: string }): void } };
  RelayMode: { custom(value: unknown): unknown; disabled(): unknown };
  SecretKey: { generate(): {toBytes():number[];public():Id} };
  presetIrohServices(builder:ReturnType<Sdk["Endpoint"]["builder"]>,options:{relays?:string[];apiSecret:string;endpointSecretKey?:number[]}):void;
}

async function loadSdk(): Promise<Sdk> {
  const directory = configuredDirectory ?? process.env["LINKSPAN_IROH_RUNTIME_DIR"] ?? fileURLToPath(new URL("./runtime", import.meta.url));
  if (!isAbsolute(directory)) throw new LinkspanError("invalid_argument", "The prepared iroh runtime directory must be absolute");
  try {
    const receipt = JSON.parse(await readFile(join(directory, "iroh-runtime.json"), "utf8")) as { target?: string; version?: string; sha256?: string; bytes?: number };
    const native = await readFile(join(directory, "iroh.node"));
    if (![`${process.platform}-${process.arch}`, `${process.platform}-${process.arch}-musl`].includes(receipt.target ?? "") || receipt.version !== "1.2.0"
      || receipt.bytes !== native.length || receipt.sha256 !== createHash("sha256").update(native).digest("hex")) {
      throw new Error("The prepared runtime did not match the host target or integrity receipt.");
    }
    return createRequire(import.meta.url)(join(directory, "iroh.node")) as Sdk;
  } catch (cause) { throw new LinkspanError("unavailable", "The fixed native iroh runtime must be prepared and packaged for this target", { cause }); }
}

function carrier(connection: Connection, bi: Bi, release: () => Promise<void>): PeerStream {
  connection.setMaxConcurrentBiStreams(1n);
  connection.setMaxConcurrentUniStreams(0n);
  connection.setReceiveWindow(512n * 1024n);
  let ended = false;
  let reading = false;
  let writing = false;
  const abort = () => {
    if (ended) return;
    ended = true;
    connection.close(1n, []);
    void bi.recv.stop(1n).catch(() => {});
    void bi.send.reset(1n).catch(() => {});
    void release().catch(() => {});
  };
  return {
    remoteEndpointId: connection.remoteId().toString(),
    async read() {
      if (ended) return null;
      if (reading) throw new LinkspanError("invalid_argument", "Only one carrier read may be pending");
      reading = true;
      try { const value = await bi.recv.read(64 * 1024); return value.length === 0 ? null : Uint8Array.from(value); }
      catch (error) { abort(); throw asLinkspanError(error); }
      finally { reading = false; }
    },
    async write(bytes) {
      if (ended) throw new LinkspanError("closed", "The iroh carrier is closed");
      if (writing || bytes.byteLength > 128 * 1024) throw new LinkspanError("resource_exhausted", "The bounded iroh carrier write limit was exceeded");
      writing = true;
      try { await bi.send.writeAll(Array.from(bytes)); }
      catch (error) { abort(); throw asLinkspanError(error); }
      finally { writing = false; }
    },
    async close() {
      if (ended) return;
      ended = true;
      try{await bi.send.finish();}
      finally{connection.close(0n,[]);await release();}
    },
    abort,
  };
}

export async function createIrohRuntime(): Promise<IrohRuntime> {
  const directory = configuredDirectory ?? process.env["LINKSPAN_IROH_RUNTIME_DIR"] ?? fileURLToPath(new URL("./runtime", import.meta.url));
  if (process.platform === "darwin" && process.arch === "x64") {
    const receipt = JSON.parse(await readFile(join(directory,"iroh-runtime.json"),"utf8")) as {target?: string;kind?: string;files?: Record<string,string>};
    if(receipt.kind!=="wasm")return createNativeIrohRuntime(await loadSdk());
    if (receipt.target !== "darwin-x64" || !receipt.files) throw new LinkspanError("unavailable","The packaged iroh WASM fallback is required for this selected mode");
    for (const name of ["index.js","runtime/linkspan_iroh.js","runtime/linkspan_iroh_bg.wasm"]) {
      const bytes = await readFile(join(directory,"wasm",name));
      if (receipt.files[name] !== createHash("sha256").update(bytes).digest("hex")) throw new LinkspanError("unavailable","The packaged iroh WASM fallback failed integrity verification");
    }
    const runtime = await import(pathToFileURL(join(directory,"wasm","index.js")).href) as {configureIrohWasm(bytes:Uint8Array):void;createIrohRuntime():Promise<IrohRuntime>};
    runtime.configureIrohWasm(await readFile(join(directory,"wasm","runtime","linkspan_iroh_bg.wasm")));
    return runtime.createIrohRuntime();
  }
  return createNativeIrohRuntime(await loadSdk());
}
function createNativeIrohRuntime(sdk:Sdk):IrohRuntime {
  const clients=createResourcePool<Endpoint>(endpoint=>endpoint.close());
  let ephemeral=0;
  async function bind(config: { secretKey?: Uint8Array; relayUrls?: readonly string[]; relayToken?: string; servicesApiSecret?:string } = {}) {
    const builder = sdk.Endpoint.builder();
    if(config.relayUrls?.length===0)builder.applyMinimal();else builder.applyN0();
    builder.alpns([ALPN]);
    if (config.servicesApiSecret !== undefined) throw new LinkspanError("invalid_argument","Publisher relay credentials require bounded lease preparation");
    if (config.secretKey !== undefined) {
      if (config.secretKey.length !== 32) throw new LinkspanError("invalid_argument", "The iroh secret key must contain 32 bytes");
      builder.secretKey(Array.from(config.secretKey));
    }
    if (config.relayToken && !config.relayUrls?.length) throw new LinkspanError("invalid_argument", "An explicit relay URL is required when a paid relay token is supplied");
    if (config.relayUrls) {
      if (config.relayUrls.length > 8) throw new LinkspanError("invalid_argument", "Configure at most eight relay URLs");
      if (config.relayUrls.length === 0) { builder.relayMode(sdk.RelayMode.disabled()); return builder.bind(); }
      const relays = sdk.RelayMap.empty();
      for (const address of config.relayUrls) {
        const url = new URL(address);
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new LinkspanError("invalid_argument", "An HTTPS relay URL without credentials is required");
        relays.insert({ url: url.href, ...(config.relayToken === undefined ? {} : { authToken: config.relayToken }) });
      }
      builder.relayMode(sdk.RelayMode.custom(relays));
    }
    return builder.bind();
  }
  return {
    async generateIdentity() {
      const key = sdk.SecretKey.generate();
      return {privateKey:Buffer.from(key.toBytes()).toString("hex"),publicKey:key.public().toString()};
    },
    async connect(options) {
      const scope = createOperationScope({...options,...(options.relayTokenExpiresAt===undefined?{}:{deadline:Math.min(options.deadline??Infinity,options.relayTokenExpiresAt)})});
      let endpoint: Endpoint | undefined;
      let stream: PeerStream | undefined;
      let expiryTimer:ReturnType<typeof setTimeout> | undefined;
      let releaseEndpoint:(()=>Promise<void>)|undefined;
      let dialing:Connection|undefined;
      const cancel = () => {stream?.abort();dialing?.close(1n,[]);if(releaseEndpoint)void releaseEndpoint().catch(()=>{});};
      scope.signal.addEventListener("abort", cancel, { once: true });
      try {
        scope.check();
        const address = sdk.EndpointTicket.fromString(options.ticket).endpointAddr();
        if (address.id().toString() !== options.expectedEndpointId) throw new LinkspanError("identity_mismatch", "The iroh ticket did not match the trusted endpoint id");
        if (options.clientKey!==undefined && !/^[a-f0-9]{64}$/u.test(options.clientKey)) throw new LinkspanError("invalid_argument","A complete local backend key is required");
        const lease=await clients.acquire(options.clientKey??`ephemeral:${++ephemeral}`,()=>bind({...(options.clientKey===undefined?{}:{secretKey:Uint8Array.from(Buffer.from(options.clientKey,"hex"))}),...(options.relayUrls===undefined?{}:{relayUrls:options.relayUrls}),...(options.relayToken===undefined?{}:{relayToken:options.relayToken})}),{signal:scope.signal,configuration:JSON.stringify(options.relayUrls??null)});
        const own=lease.value;releaseEndpoint=lease.release;
        endpoint=own;
        if(options.relayToken!==undefined)for(const url of options.relayUrls??[])await scope.wait(own.insertRelay({url,authToken:options.relayToken}));
        const connection = await scope.wait(own.connect(address, ALPN).then(value=>{if(scope.signal.aborted)value.close(1n,[]);return value;}));
        dialing=connection;
        if (connection.remoteId().toString() !== options.expectedEndpointId) throw new LinkspanError("identity_mismatch", "The iroh handshake did not authenticate the trusted endpoint id");
        const bi = await scope.wait(connection.openBi());
        stream = carrier(connection, bi, () => {if(expiryTimer!==undefined)clearTimeout(expiryTimer);return lease.release();});
        if(options.relayTokenExpiresAt!==undefined)expiryTimer=setTimeout(()=>{stream?.abort();},Math.max(0,options.relayTokenExpiresAt-Date.now()));
        scope.check();
        return stream;
      } catch (error) { if(expiryTimer!==undefined)clearTimeout(expiryTimer);cancel(); throw asLinkspanError(error); }
      finally { scope.signal.removeEventListener("abort", cancel); scope.dispose(); }
    },
    async listen(options) {
      const scope = createOperationScope(options);
      let endpoint: Endpoint | undefined;
      let expiryTimer:ReturnType<typeof setTimeout> | undefined;
      let renewalTimer:ReturnType<typeof setTimeout> | undefined;
      const cancel = () => { void endpoint?.close().catch(() => {}); };
      scope.signal.addEventListener("abort", cancel, { once: true });
      try {
        scope.check();
        const ttl=options.servicesTokenTtlSeconds??3600;
        let config={...options};
        let leaseExpiry=options.relayTokenExpiresAt;
        let mint:(()=>Promise<{relayToken:string;expiresAt:number}>)|undefined;
        if(options.servicesApiSecret!==undefined){
          if(!options.relayUrls?.length||options.relayToken!==undefined||!Number.isInteger(ttl)||ttl<60||ttl>86400)throw new LinkspanError("invalid_argument","Publisher relay leases require explicit relays and a bounded TTL");
          const signer=await scope.wait(import("@jokoagent/linkspan-iroh-services"));
          const secret=options.secretKey??Uint8Array.from(sdk.SecretKey.generate().toBytes());
          const endpointId=await scope.wait(signer.irohPublicKeyFromPrivateKey(secret));
          const apiSecret=options.servicesApiSecret;
          mint=()=>signer.issueIrohRelayLease({apiSecret,endpointId,ttlSeconds:ttl,deadline:Date.now()+5000});
          const lease=await scope.wait(mint());leaseExpiry=lease.expiresAt;
          const {servicesApiSecret:_publisher,...rest}=config;
          config={...rest,secretKey:secret,relayToken:lease.relayToken,relayTokenExpiresAt:lease.expiresAt};
        }
        const own:Endpoint = await scope.wait(bind(config).then(value=>{if(scope.signal.aborted)void value.close().catch(()=>{});return value;}));
        endpoint=own;
        if (options.relayUrls?.length !== 0) await scope.wait(own.online());
        const streams = new Set<PeerStream>();
        let accepting = false;
        let ended=false;
        let closing:Promise<void>|undefined;
        const ownerAbort=()=>{void close().catch(()=>{});};
        const close = ():Promise<void> => {
          if(closing)return closing;
          ended=true;
          if(expiryTimer!==undefined)clearTimeout(expiryTimer);
          if(renewalTimer!==undefined)clearTimeout(renewalTimer);
          options.signal?.removeEventListener("abort",ownerAbort);
          for(const stream of streams)stream.abort();
          streams.clear();
          const pending=Promise.resolve().then(()=>own.close());
          closing=pending;
          // Keep the original endpoint on failure so explicit cleanup can retry.
          void pending.catch(()=>{if(closing===pending)closing=undefined;});
          return pending;
        };
        const scheduleLease=()=>{
          if(leaseExpiry===undefined||ended)return;
          if(expiryTimer!==undefined)clearTimeout(expiryTimer);
          expiryTimer=setTimeout(ownerAbort,Math.max(0,leaseExpiry-Date.now()));
          if(mint!==undefined)renewalTimer=setTimeout(()=>{void(async()=>{
            try{const lease=await mint!();if(ended)return;for(const url of options.relayUrls!){if(ended)return;await own.insertRelay({url,authToken:lease.relayToken});}if(ended)return;leaseExpiry=lease.expiresAt;scheduleLease();}
            catch{ownerAbort();}
          })();},Math.max(1,leaseExpiry-Date.now()-Math.min(30000,ttl*100)));
        };
        scheduleLease();
        options.signal?.addEventListener("abort",ownerAbort,{once:true});
        return {
          endpointId: own.id().toString(), ticket: sdk.EndpointTicket.fromAddr(own.addr()).toString(),
          async accept(acceptOptions: OperationOptions = {}) {
            if(ended)return null;
            if (accepting) throw new LinkspanError("invalid_argument", "Only one listener accept may be pending");
            accepting = true;
            const attempt = createOperationScope(acceptOptions);
            const cancelled = ownerAbort;
            attempt.signal.addEventListener("abort", cancelled, { once: true });
            try {
              for(;;){
                attempt.check();
                const incoming=await attempt.wait(own.acceptNext());if(incoming===null||ended)return null;
                const peer=createOperationScope({signal:attempt.signal,deadline:Math.min(acceptOptions.deadline??Infinity,Date.now()+10000)});
                let connection:Connection|undefined;
                try{
                  const pending=await peer.wait(incoming.accept());
                  const current:Connection=await peer.wait(pending.connect().then(value=>{if(peer.signal.aborted)value.close(1n,[]);return value;}));
                  connection=current;
                  const bi=await peer.wait(current.acceptBi());
                  if(ended){current.close(1n,[]);return null;}
                  let stream:PeerStream;stream=carrier(current,bi,async()=>{streams.delete(stream);});streams.add(stream);return stream;
                }catch{connection?.close(1n,[]);attempt.check();if(ended)return null;await attempt.wait(new Promise<void>(resolve=>setTimeout(resolve,10)));}
                finally{peer.dispose();}
              }
            } finally { accepting = false; attempt.signal.removeEventListener("abort", cancelled); attempt.dispose(); }
          },
          close,
        };
      } catch (error) { cancel(); throw asLinkspanError(error); }
      finally { scope.signal.removeEventListener("abort", cancel); scope.dispose(); }
    },
  };
}

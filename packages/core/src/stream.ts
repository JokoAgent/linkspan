import { LinkspanError, asLinkspanError, createOperationScope } from "./index.js";
import type { OperationOptions } from "./index.js";

/** Ordered carrier bytes; the security implementation supplies its own framing. */
export interface StreamCarrier {
  read(): Promise<Uint8Array | null>;
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): void;
}

export interface PeerStream extends StreamCarrier { readonly remoteEndpointId: string }

export interface ResourceLease<T> { readonly value:T; release():Promise<void> }
/** Reuse one SDK resource identity across concurrent streams, with single-owner release. */
export function createResourcePool<T>(destroy:(value:T)=>Promise<void>,limit=128) {
  const entries=new Map<string,{promise:Promise<T>;references:number;configuration?:string;closing?:Promise<void>}>();
  return {
    async acquire(key:string,create:()=>Promise<T>,options:OperationOptions&{configuration?:string}={}):Promise<ResourceLease<T>>{
      const scope=createOperationScope(options);scope.check();
      let entry=entries.get(key);
      if(entry&&entry.configuration!==options.configuration){scope.dispose();throw new LinkspanError("invalid_argument","The active SDK identity has a different relay configuration");}
      if(!entry){
        if(entries.size>=limit){scope.dispose();throw new LinkspanError("resource_exhausted","The SDK resource limit was reached");}
        entry={promise:Promise.resolve().then(create),references:0,...(options.configuration===undefined?{}:{configuration:options.configuration})};entries.set(key,entry);
      }
      const selected=entry;selected.references++;
      let released=false;
      const release=async()=>{
        if(released)return;released=true;selected.references--;
        if(selected.references!==0)return;
        if(entries.get(key)===selected)entries.delete(key);
        selected.closing??=selected.promise.then(destroy,()=>{});await selected.closing;
      };
      try{const value=await scope.wait(selected.promise);return{value,release};}
      catch(error){void release().catch(()=>{});throw error;}
      finally{scope.dispose();}
    },
  };
}
export interface StreamBridgeRequest {
  readonly method: "connect" | "read" | "write" | "close" | "abort" | "identity";
  readonly streamId: string;
  readonly args?: unknown;
}
/** A host-owned, local, trusted WebView/native bridge. Never use a public relay. */
export interface StreamBridge { request(message: StreamBridgeRequest): Promise<unknown> }

const MAX_BYTES = 128 * 1024;
const VALID_ID = /^[a-f0-9]{32}$/u;

function bytesFrom(value: unknown): Uint8Array {
  if (!Array.isArray(value) || value.length > MAX_BYTES || value.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
    throw new LinkspanError("protocol_error", "Invalid bridge byte buffer");
  }
  return Uint8Array.from(value as number[]);
}

/** The security handshake runs in the caller; the bridge only sees carrier bytes. */
export async function connectStreamBridge(bridge: StreamBridge, args: unknown, options: OperationOptions = {}): Promise<PeerStream> {
  const streamId = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  const scope = createOperationScope(options);
  let ended = false;
  const abort = () => {
    if (ended) return;
    ended = true;
    void bridge.request({ method: "abort", streamId }).catch(() => {});
  };
  scope.signal.addEventListener("abort", abort, { once: true });
  try {
    scope.check();
    const result = await scope.wait(bridge.request({ method: "connect", streamId, args }));
    if (typeof result !== "object" || result === null || typeof (result as { remoteEndpointId?: unknown }).remoteEndpointId !== "string") {
      throw new LinkspanError("protocol_error", "The bridge did not identify its peer");
    }
    const remoteEndpointId = (result as { remoteEndpointId: string }).remoteEndpointId;
    let reading = false;
    let writing = false;
    return {
      remoteEndpointId,
      async read() {
        if (ended) return null;
        if (reading) throw new LinkspanError("invalid_argument", "Only one carrier read may be pending");
        reading = true;
        try {
          const value = await bridge.request({ method: "read", streamId });
          return value === null ? null : bytesFrom(value);
        } finally { reading = false; }
      },
      async write(bytes) {
        if (ended) throw new LinkspanError("closed", "The bridge stream is closed");
        if (writing) throw new LinkspanError("resource_exhausted", "Only one carrier write may be pending");
        if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new LinkspanError("invalid_argument", "The carrier buffer limit was exceeded");
        writing = true;
        try { await bridge.request({ method: "write", streamId, args: Array.from(bytes) }); }
        finally { writing = false; }
      },
      async close() {
        if (ended) return;
        ended = true;
        await bridge.request({ method: "close", streamId });
      },
      abort,
    };
  } catch (error) { abort(); throw asLinkspanError(error); }
  finally { scope.signal.removeEventListener("abort", abort); scope.dispose(); }
}

export interface StreamBridgeHost {
  request(message: StreamBridgeRequest): Promise<unknown>;
  dispose(): void;
}

/** Fixed stream operations, with bounded state and cancellation of pending dials. */
export function createStreamBridgeHost(connect: (args: unknown, options: OperationOptions) => Promise<PeerStream>): StreamBridgeHost {
  const streams = new Map<string, { controller: AbortController; promise: Promise<PeerStream>; reading: boolean; writing: boolean }>();
  let disposed = false;
  return {
    async request(message) {
      if (disposed) throw new LinkspanError("closed", "The local bridge is closed");
      if (!message || !VALID_ID.test(message.streamId)) throw new LinkspanError("invalid_argument", "Invalid bridge stream identifier");
      if (message.method === "connect") {
        if (streams.has(message.streamId)) throw new LinkspanError("invalid_argument", "The bridge stream identifier is already in use");
        if (streams.size >= 128) throw new LinkspanError("resource_exhausted", "The bridge stream limit was reached");
        const controller = new AbortController();
        const promise = Promise.resolve().then(() => connect(message.args, { signal: controller.signal, deadline: Date.now() + 30_000 }));
        const entry = { controller, promise, reading: false, writing: false };
        streams.set(message.streamId, entry);
        try {
          const stream = await promise;
          if (controller.signal.aborted) { stream.abort(); throw new LinkspanError("cancelled", "The bridge dial was cancelled"); }
          return { remoteEndpointId: stream.remoteEndpointId };
        } catch (error) { if (streams.get(message.streamId) === entry) streams.delete(message.streamId); throw asLinkspanError(error); }
      }
      const entry = streams.get(message.streamId);
      if (!entry) {
        if (message.method === "abort" || message.method === "close") return;
        throw new LinkspanError("closed", "The bridge stream is closed");
      }
      if (message.method === "abort" || message.method === "close") {
        streams.delete(message.streamId);
        entry.controller.abort();
        const stream = await entry.promise.catch(() => undefined);
        if (message.method === "abort") stream?.abort();
        else await stream?.close();
        return;
      }
      const stream = await entry.promise;
      if (message.method === "read") {
        if (entry.reading) throw new LinkspanError("invalid_argument", "Only one carrier read may be pending");
        entry.reading = true;
        try {
          const bytes = await stream.read();
          if (bytes !== null && bytes.byteLength > MAX_BYTES) throw new LinkspanError("resource_exhausted", "The bridge carrier buffer limit was exceeded");
          return bytes === null ? null : Array.from(bytes);
        } finally { entry.reading = false; }
      }
      if (message.method === "write") {
        if (entry.writing) throw new LinkspanError("resource_exhausted", "Only one carrier write may be pending");
        entry.writing = true;
        try { await stream.write(bytesFrom(message.args)); }
        finally { entry.writing = false; }
        return;
      }
      throw new LinkspanError("invalid_argument", "Unknown bridge stream method");
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const entry of streams.values()) {
        entry.controller.abort();
        void entry.promise.then(stream => stream.abort(), () => {});
      }
      streams.clear();
    },
  };
}

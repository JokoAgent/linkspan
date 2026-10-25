import { LinkspanError } from "@jokoagent/linkspan-core";
import type { OperationOptions } from "@jokoagent/linkspan-core";
import type { PeerStream } from "@jokoagent/linkspan-core/stream";
export interface TailcatIdentity { privateKey: string; publicKey: string; presharedKey: string }
export interface TailcatRuntime {
  dispose?(): void;
  generateIdentity(): Promise<TailcatIdentity>;
  connect(options: OperationOptions & {address:string;expectedEndpointId:string;port:number;clientKey?:string;derpMapUrl?:string}): Promise<PeerStream>;
  listen(options: OperationOptions & {port?:number;serverKey?:string;presharedKey?:string;allowedClients:readonly string[];allowPrivateAddressPairing?:boolean;derpMapUrl?:string;regionId?:number}): Promise<{address:string;endpointId:string;port:number;accept(options?:OperationOptions):Promise<PeerStream|null>;close():Promise<void>}>;
}

export type TailcatRpc = (method: string, args: Record<string, unknown>, options?: OperationOptions) => Promise<unknown>;
interface OpenResult { handle: string; remoteEndpointId: string }
function opened(value: unknown): OpenResult {
  const item = value as Partial<OpenResult> | null;
  if (!item || typeof item.handle !== "string" || !/^[0-9]{1,16}$/u.test(item.handle) || typeof item.remoteEndpointId !== "string") throw new LinkspanError("protocol_error", "The tailcat binding returned an invalid stream");
  return item as OpenResult;
}
export function createTailcatRuntimeFromRpc(request: TailcatRpc): TailcatRuntime {
  function carrier(value: unknown): PeerStream {
    const result = opened(value);
    let ended = false;
    const abort = () => {
      if (ended) return;
      ended = true;
      void request("abort", { handle: result.handle }).catch(() => {});
    };
    return {
      remoteEndpointId: result.remoteEndpointId,
      async read() {
        if (ended) return null;
        const encoded = await request("read", { handle: result.handle });
        if (encoded === null) return null;
        if (typeof encoded !== "string" || encoded.length > 175000 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) throw new LinkspanError("protocol_error", "The tailcat binding returned an invalid byte buffer");
        return Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      },
      async write(bytes) {
        if (ended) throw new LinkspanError("closed", "The tailcat carrier is closed");
        if (!(bytes instanceof Uint8Array) || bytes.length > 128 * 1024) throw new LinkspanError("resource_exhausted", "The tailcat carrier write limit was exceeded");
        let binary = "";
        for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        await request("write", { handle: result.handle, data: btoa(binary) });
      },
      async close() { if (!ended) { ended = true; await request("close", { handle: result.handle }); } },
      abort,
    };
  }
  return {
    async generateIdentity() {
      const value = await request("generateIdentity",{}) as {serverKey?:unknown;endpointId?:unknown;presharedKey?:unknown};
      if (!value || typeof value.serverKey!=="string" || !/^privkey:[0-9a-f]{64}$/u.test(value.serverKey) || typeof value.endpointId!=="string" || !/^nodekey:[0-9a-f]{64}$/u.test(value.endpointId) || typeof value.presharedKey!=="string" || !/^psk:[0-9a-f]{64}$/u.test(value.presharedKey)) throw new LinkspanError("protocol_error","The tailcat binding returned an invalid keypair");
      return {privateKey:value.serverKey,publicKey:value.endpointId,presharedKey:value.presharedKey};
    },
    async connect(options) {
      return carrier(await request("connect", { address: options.address, expectedEndpointId: options.expectedEndpointId, port: options.port, ...(options.clientKey === undefined ? {} : { clientKey: options.clientKey }),...(options.derpMapUrl===undefined?{}:{derpMapUrl:options.derpMapUrl}) }, options));
    },
    async listen(options) {
      const result = await request("listen", { port: options.port ?? 0, ...(options.serverKey === undefined ? {} : { serverKey: options.serverKey }), ...(options.presharedKey === undefined ? {} : { presharedKey: options.presharedKey }), allowedClients: [...options.allowedClients], allowPrivateAddressPairing: options.allowPrivateAddressPairing === true, ...(options.derpMapUrl === undefined ? {} : { derpMapUrl: options.derpMapUrl }), ...(options.regionId === undefined ? {} : { regionId: options.regionId }) }, options) as { handle: string; address: string; endpointId: string; port: number };
      if (!result || typeof result.handle !== "string" || typeof result.address !== "string" || typeof result.endpointId !== "string" || !Number.isInteger(result.port)) throw new LinkspanError("protocol_error", "The tailcat binding returned an invalid listener");
      let ended = false;
      const close = async () => { if (!ended) { ended = true; await request("closeListener", { handle: result.handle }); } };
      options.signal?.addEventListener("abort", () => { void close().catch(() => {}); }, { once: true });
      return {
        address: result.address, endpointId: result.endpointId, port: result.port,
        async accept(acceptOptions = {}) { if (ended) return null; return carrier(await request("accept", { handle: result.handle }, acceptOptions)); },
        close,
      };
    },
  };
}

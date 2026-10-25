declare module "*runtime/linkspan_iroh.js" {
  export default function init(options?: {module_or_path?: Uint8Array | URL}): Promise<unknown>;
  export function createIrohIdentity(): string;
  export function issueIrohRelayLease(secret:string,endpointId:string,ttl:number):string;
  export function publicKeyFromPrivate(bytes:Uint8Array):string;
  export class IrohEndpoint {
    static bind(secret: Uint8Array, config: string): Promise<IrohEndpoint>;
    endpointId(): string; ticket(): string; online(): Promise<void>; close(): Promise<void>;
    updateRelay(url:string,token:string):Promise<void>;
    connect(ticket: string, endpointId: string): Promise<{remoteEndpointId(): string;read(): Promise<Uint8Array>;write(bytes: Uint8Array): Promise<void>;close(): Promise<void>;abort(): void}>;
    accept(): Promise<{remoteEndpointId(): string;read(): Promise<Uint8Array>;write(bytes: Uint8Array): Promise<void>;close(): Promise<void>;abort(): void} | undefined>;
  }
}

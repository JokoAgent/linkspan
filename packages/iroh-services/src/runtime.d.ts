declare module "*runtime/linkspan_iroh_services.js" {
  export default function init(options:{module_or_path:Uint8Array}):Promise<unknown>;
  export function issueRelayLease(secret:string,endpointId:string,ttl:number):string;
  export function inspectRelayLease(token:string):string;
  export function publicKeyFromPrivate(bytes:Uint8Array):string;
  export function createTicket(endpointId:string,relaysJson:string):string;
}

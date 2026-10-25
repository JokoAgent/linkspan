declare module "@jokoagent/linkspan-iroh-services" {
  export function irohPublicKeyFromPrivateKey(key:Uint8Array):Promise<string>;
  export function issueIrohRelayLease(options:{apiSecret:string;endpointId:string;ttlSeconds?:number;deadline?:number}):Promise<{relayToken:string;endpointId:string;expiresAt:number;scope:"relay:use"}>;
}

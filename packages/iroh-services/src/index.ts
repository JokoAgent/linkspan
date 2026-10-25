import { readFile } from "node:fs/promises";
import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import type { OperationOptions } from "@jokoagent/linkspan-core";
import init, { issueRelayLease, inspectRelayLease, publicKeyFromPrivate,createTicket } from "./runtime/linkspan_iroh_services.js";

let initialized:Promise<unknown>|undefined;
async function initialize() {
  initialized ??= readFile(new URL("./runtime/linkspan_iroh_services_bg.wasm",import.meta.url)).then(bytes=>init({module_or_path:bytes}));
  await initialized;
}
export interface IrohRelayLease { relayToken:string;endpointId:string;expiresAt:number;scope:"relay:use" }
export interface IrohRelayLeaseOptions extends OperationOptions {apiSecret:string;endpointId:string;ttlSeconds?:number}
/** Publisher-only local delegation. The master credential is never returned. */
export async function issueIrohRelayLease(options:IrohRelayLeaseOptions):Promise<IrohRelayLease> {
  const ttl=options.ttlSeconds??3600;
  if(!options.apiSecret.startsWith("services") || options.apiSecret.length>16384 || !/^[a-f0-9]{64}$/u.test(options.endpointId) || !Number.isInteger(ttl) || ttl<60 || ttl>86400)throw new LinkspanError("invalid_argument","A bounded publisher secret, endpoint id and 60..86400 second TTL are required");
  const scope=createOperationScope(options);
  try {scope.check();await scope.wait(initialize());scope.check();return JSON.parse(issueRelayLease(options.apiSecret,options.endpointId,ttl)) as IrohRelayLease;}
  catch(error){throw asLinkspanError(error,"invalid_argument");}
  finally{scope.dispose();}
}
/** Signature-verifying diagnostics contain no resource/master secret. */
export async function inspectIrohRelayLease(token:string):Promise<{audience:string;scope:string[];expiresAt:number|null}> {
  await initialize();
  try {return JSON.parse(inspectRelayLease(token)) as {audience:string;scope:string[];expiresAt:number|null};}
  catch(error){throw asLinkspanError(error,"invalid_argument");}
}
export async function irohPublicKeyFromPrivateKey(key:Uint8Array):Promise<string> {
  if(!(key instanceof Uint8Array)||key.length!==32)throw new LinkspanError("invalid_argument","An exact backend secret key is required");
  await initialize();return publicKeyFromPrivate(key);
}
/** Pure official locator construction; no endpoint binding or network effects. */
export async function createIrohTicket(options:{endpointId:string;relayUrls:readonly string[]}):Promise<string>{
  if(!/^[a-f0-9]{64}$/u.test(options.endpointId)||!Array.isArray(options.relayUrls)||options.relayUrls.length<1||options.relayUrls.length>8)throw new LinkspanError("invalid_argument","An endpoint id and bounded relay list are required");
  await initialize();
  try{return createTicket(options.endpointId,JSON.stringify(options.relayUrls));}catch(error){throw asLinkspanError(error,"invalid_argument");}
}

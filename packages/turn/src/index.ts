import { LinkspanError } from "@jokoagent/linkspan-core";
import type { OperationOptions } from "@jokoagent/linkspan-core";

export interface TurnIceServer {
  readonly urls: readonly string[];
  readonly username: string;
  readonly credential: string;
}
export interface TurnRequest extends OperationOptions {
  /** The host records this operation before any provider request. */
  readonly requestId: string;
  readonly ttlSeconds: number;
}
export interface ExpiringTurnResource {
  readonly kind: "twilio.turn" | "coturn.turn";
  readonly requestId: string;
  readonly keyId: string;
  readonly usernames: readonly string[];
  readonly expiresAt: number;
  /** These providers do not expose individual credential revocation. */
  readonly revocation: "ttl-only";
}
export interface TurnCredentials {
  readonly iceServers: readonly TurnIceServer[];
  readonly expiresAt: number;
  readonly resource: ExpiringTurnResource;
}
export const EXPIRING_TURN_LIMITS = Object.freeze({ maximumTtlSeconds: 86400, responseBytes: 16384,
  individualRevocation: false, revocation: "ttl-only", existingAllocationRevocation: "requires-live-verification" });

export function validateTurnRequest(options: TurnRequest): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.requestId)
    || !Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1 || options.ttlSeconds > 86400) throw invalidTurn();
}
export function validTurnField(value: unknown, maximum = 4096): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u0020\u007f]/u.test(value);
}
export function invalidTurn(): LinkspanError {
  return new LinkspanError("invalid_argument", "The TURN request, access or material is invalid.", { outcome: "not_sent" });
}
export function unknownTurn(): LinkspanError {
  return new LinkspanError("outcome_unknown", "The TURN request was dispatched but its result is unconfirmed. Reconcile the original operation or wait for its TTL.", { outcome: "unknown" });
}
export function validateTurnUrl(value: unknown): value is string {
  return typeof value === "string" && value.length <= 512
    && /^turns?:(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[a-f0-9:]+\]):(?:[1-9][0-9]{0,4})(?:\?transport=(?:tcp|udp))?$/iu.test(value)
    && Number(value.match(/\]?:([0-9]+)(?:\?|$)/u)?.[1]) <= 65535
    && (!value.startsWith("turns:") || !value.endsWith("transport=udp"));
}
/** Local retirement never claims that the provider has revoked a token. */
export function retireExpiringTurnResource(resource: ExpiringTurnResource, ownership: {
  readonly kind: ExpiringTurnResource["kind"]; readonly keyId: string; readonly issueRequestId: string;
}): { readonly state: "expired" | "awaiting-expiry"; readonly expiresAt: number; readonly individualRevocation: false } {
  if (resource.kind !== ownership.kind || resource.keyId !== ownership.keyId || resource.requestId !== ownership.issueRequestId
    || resource.revocation !== "ttl-only" || !Number.isSafeInteger(resource.expiresAt)
    || !Array.isArray(resource.usernames) || resource.usernames.length < 1 || resource.usernames.length > 4
    || resource.usernames.some(username => !validTurnField(username, 256))) throw invalidTurn();
  return Object.freeze({ state: resource.expiresAt <= Date.now() ? "expired" : "awaiting-expiry", expiresAt: resource.expiresAt, individualRevocation: false });
}

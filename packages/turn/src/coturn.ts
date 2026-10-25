import { createHmac } from "node:crypto";
import { createOperationScope, LinkspanError } from "@jokoagent/linkspan-core";
import { invalidTurn, validateTurnRequest, validateTurnUrl, type TurnCredentials, type TurnRequest } from "./index.js";

export interface CoturnRestAccess {
  /** The host's selected server/secret identifier, never the secret itself. */
  readonly keyId: string;
  readonly urls: readonly string[];
  readonly readSharedSecret: (signal: AbortSignal) => Promise<string>;
}
/** coturn's documented TURN REST HMAC-SHA1 credentials; no network mutation. */
export async function issueCoturnRestCredentials(access: CoturnRestAccess, options: TurnRequest): Promise<TurnCredentials> {
  validateTurnRequest(options);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(access.keyId) || typeof access.readSharedSecret !== "function"
    || !Array.isArray(access.urls) || access.urls.length < 1 || access.urls.length > 4 || !access.urls.every(validateTurnUrl)) throw invalidTurn();
  const scope = createOperationScope(options);
  try {
    scope.check();
    const secret = await scope.wait(access.readSharedSecret(scope.signal));
    if (typeof secret !== "string" || secret.length < 16 || secret.length > 4096 || /[\u0000\r\n]/u.test(secret)) throw invalidTurn();
    scope.check();
    // The REST username uses whole seconds. Round down, never promise a longer TTL.
    const expiresAt = Math.floor(Date.now() / 1000 + options.ttlSeconds) * 1000;
    const username = `${expiresAt / 1000}:${options.requestId}`;
    const credential = createHmac("sha1", secret).update(username).digest("base64");
    return Object.freeze({ iceServers: Object.freeze([Object.freeze({ urls: Object.freeze([...access.urls]), username, credential })]), expiresAt,
      resource: Object.freeze({ kind: "coturn.turn", keyId: access.keyId, requestId: options.requestId,
        usernames: Object.freeze([username]), expiresAt, revocation: "ttl-only" }) });
  } catch (error) {
    if (error instanceof LinkspanError) throw error;
    throw new LinkspanError("unavailable", "The selected TURN shared secret is unavailable.", { outcome: "not_sent" });
  } finally { scope.dispose(); }
}

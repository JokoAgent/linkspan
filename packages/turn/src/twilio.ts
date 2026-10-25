import { Buffer } from "node:buffer";
import { createOperationScope, LinkspanError } from "@jokoagent/linkspan-core";
import { invalidTurn, unknownTurn, validTurnField, validateTurnRequest, validateTurnUrl,
  type TurnCredentials, type TurnIceServer, type TurnRequest } from "./index.js";

export interface TwilioTurnAccess {
  readonly accountSid: string;
  /** Explicit provider-account opt-in. Account budgets remain with the account owner. */
  readonly enabled: true;
  /** Account SID/Auth Token or API Key SID/API Secret, limited to this account. */
  readonly readCredentials: (signal: AbortSignal) => Promise<{ readonly username: string; readonly secret: string }>;
  readonly fetch?: typeof globalThis.fetch;
}
export async function issueTwilioTurnCredentials(access: TwilioTurnAccess, options: TurnRequest): Promise<TurnCredentials> {
  validateTurnRequest(options);
  if (access.enabled !== true || !/^AC[a-f0-9]{32}$/iu.test(access.accountSid) || typeof access.readCredentials !== "function") throw invalidTurn();
  const scope = createOperationScope({ ...options, deadline: Math.min(options.deadline ?? Infinity, Date.now() + 3000) });
  const expiresAt = Date.now() + options.ttlSeconds * 1000;
  let dispatched = false;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    scope.check();
    const credentials = await scope.wait(access.readCredentials(scope.signal));
    if (!(credentials.username === access.accountSid || /^SK[a-f0-9]{32}$/iu.test(credentials.username)) || !validTurnField(credentials.secret)) throw invalidTurn();
    scope.check(); dispatched = true;
    response = await scope.wait((access.fetch ?? globalThis.fetch)(`https://api.twilio.com/2010-04-01/Accounts/${access.accountSid}/Tokens.json`, {
      method: "POST", redirect: "error", cache: "no-store", signal: scope.signal,
      headers: { authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.secret}`, "utf8").toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams({ Ttl: String(options.ttlSeconds) }).toString()
    }));
    if (response.status !== 201) {
      if ([400, 401, 403, 404, 422, 429].includes(response.status)) {
        dispatched = false;
        throw new LinkspanError([401, 403].includes(response.status) ? "authentication_failed" : response.status === 429 ? "resource_exhausted" : "invalid_argument",
          "The TURN provider rejected the request.", { outcome: "not_sent" });
      }
      throw unknownTurn();
    }
    if (Number(response.headers.get("content-length")) > 16384) throw unknownTurn();
    reader = response.body?.getReader();
    if (reader === undefined) throw unknownTurn();
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) {
      const item = await scope.wait(reader.read()); if (item.done) break;
      size += item.value.byteLength; if (size > 16384) throw unknownTurn(); chunks.push(item.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    const ttl = Number(value.ttl);
    if (value.account_sid !== access.accountSid || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > options.ttlSeconds
      || !Array.isArray(value.ice_servers) || value.ice_servers.length > 8) throw unknownTurn();
    const iceServers: TurnIceServer[] = [];
    for (const entry of value.ice_servers) {
      if (entry === null || typeof entry !== "object") throw unknownTurn();
      const server = entry as Record<string, unknown>;
      const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
      if (!Array.isArray(urls) || urls.length < 1 || urls.length > 4 || urls.some(url => typeof url !== "string" || !/^(?:stun|turns?):(?:[a-z0-9-]+\.)+twilio\.com:/iu.test(url))) throw unknownTurn();
      const turn = urls.filter(url => /^turns?:/iu.test(url)); if (turn.length === 0) continue;
      if (turn.length !== urls.length || !turn.every(validateTurnUrl) || !validTurnField(server.username, 256) || !validTurnField(server.credential, 256)) throw unknownTurn();
      iceServers.push(Object.freeze({ urls: Object.freeze(turn), username: server.username, credential: server.credential }));
    }
    if (iceServers.length < 1 || iceServers.length > 4) throw unknownTurn();
    const expiry = expiresAt - (options.ttlSeconds - ttl) * 1000;
    return Object.freeze({ iceServers: Object.freeze(iceServers), expiresAt: expiry,
      resource: Object.freeze({ kind: "twilio.turn", keyId: access.accountSid, requestId: options.requestId,
        usernames: Object.freeze([...new Set(iceServers.map(server => server.username))]), expiresAt: expiry, revocation: "ttl-only" }) });
  } catch (error) {
    if (dispatched) throw unknownTurn();
    if (error instanceof LinkspanError) throw error;
    throw new LinkspanError("unavailable", "The selected TURN provider credentials are unavailable.", { outcome: "not_sent" });
  } finally {
    if (reader !== undefined) void reader.cancel().catch(() => undefined);
    else if (response?.body) void response.body.cancel().catch(() => undefined);
    scope.dispose();
  }
}

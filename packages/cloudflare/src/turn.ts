import { createOperationScope, LinkspanError, type OperationOptions } from "@jokoagent/linkspan-core";

/** TURN API access is server-side and limited to the explicitly selected key. */
export interface CloudflareTurnAccess {
  readonly keyId: string;
  readonly readApiToken: (signal: AbortSignal) => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

export interface TurnIceServer {
  readonly urls: readonly string[];
  readonly username: string;
  readonly credential: string;
}

/** Keep this handle private. It identifies exactly the credentials issued here. */
export interface CloudflareTurnResource {
  readonly kind: "cloudflare.turn";
  readonly requestId: string;
  readonly keyId: string;
  readonly usernames: readonly string[];
  readonly expiresAt: number;
}

export interface CloudflareTurnCredentials {
  readonly iceServers: readonly TurnIceServer[];
  readonly expiresAt: number;
  readonly resource: CloudflareTurnResource;
}

export const CLOUDFLARE_TURN_LIMITS = Object.freeze({
  maximumTtlSeconds: 86_400,
  responseBytes: 16_384,
  individualRevocation: true,
  existingAllocationRevocation: "requires-live-verification" as const
});

interface RequestOptions extends OperationOptions {
  /** Reserved durably by the host before calling. The upstream has no dedupe API. */
  readonly requestId: string;
}

/**
 * Issues generic ICE material, without host users, devices or business secrets.
 * A lost response is outcome_unknown: never repeat generation under a new ID.
 */
export async function issueCloudflareTurnCredentials(
  access: CloudflareTurnAccess,
  options: RequestOptions & { readonly ttlSeconds: number }
): Promise<CloudflareTurnCredentials> {
  validateAccess(access, options.requestId);
  if (!Number.isSafeInteger(options.ttlSeconds) || options.ttlSeconds < 1
    || options.ttlSeconds > CLOUDFLARE_TURN_LIMITS.maximumTtlSeconds) throw invalid();
  // Starting the expiry clock before dispatch is conservative about transit time.
  const expiresAt = Date.now() + options.ttlSeconds * 1_000;
  const value = await request(access, options, "credentials/generate-ice-servers", { ttl: options.ttlSeconds }, 201);
  try {
    const iceServers = parseMaterial(value);
    const usernames = Object.freeze([...new Set(iceServers.map(server => server.username))]);
    return Object.freeze({ iceServers, expiresAt,
      resource: Object.freeze({ kind: "cloudflare.turn", requestId: options.requestId,
        keyId: access.keyId, usernames, expiresAt }) });
  } catch {
    throw unknown();
  }
}

/** Idempotent retirement of this exact handle; never removes the shared TURN key. */
export async function revokeCloudflareTurnCredentials(
  access: CloudflareTurnAccess,
  resource: CloudflareTurnResource,
  options: RequestOptions
): Promise<void> {
  validateAccess(access, options.requestId);
  if (resource.kind !== "cloudflare.turn" || resource.keyId !== access.keyId
    || !validId(resource.requestId) || !Number.isSafeInteger(resource.expiresAt)
    || !Array.isArray(resource.usernames) || resource.usernames.length < 1 || resource.usernames.length > 4
    || resource.usernames.some(value => !validField(value, 256))) throw invalid();
  for (const username of new Set(resource.usernames)) {
    await request(access, options, `credentials/${encodeURIComponent(username)}/revoke`, undefined, 204);
  }
}

function validId(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value); }
function validField(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u0020\u007f]/u.test(value);
}
function validateAccess(access: CloudflareTurnAccess, requestId: string): void {
  if (!validId(requestId) || !/^[A-Za-z0-9_-]{1,128}$/u.test(access.keyId)
    || typeof access.readApiToken !== "function") throw invalid();
}
function invalid(): LinkspanError { return new LinkspanError("invalid_argument", "The TURN request or resource bounds are invalid.", { outcome: "not_sent" }); }
function unknown(): LinkspanError { return new LinkspanError("outcome_unknown", "The TURN request was dispatched but its result could not be confirmed. Reconcile the original resource or wait for its TTL; do not regenerate it automatically.", { outcome: "unknown" }); }

async function request(access: CloudflareTurnAccess, options: RequestOptions, path: string,
  body: unknown, expectedStatus: number): Promise<unknown> {
  const scope = createOperationScope({ ...options, deadline: Math.min(options.deadline ?? Infinity, Date.now() + 3_000) });
  let dispatched = false;
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    scope.check();
    const token = await scope.wait(access.readApiToken(scope.signal));
    if (!validField(token, 4096)) throw invalid();
    scope.check();
    dispatched = true;
    response = await scope.wait((access.fetch ?? globalThis.fetch)(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(access.keyId)}/${path}`, {
        method: "POST", redirect: "error", cache: "no-store", signal: scope.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      }));
    if (response.status !== expectedStatus) {
      // Explicit client rejection is a known failure. Server errors can occur
      // after a mutation and must retain the original host recovery record.
      if ([400, 401, 403, 404, 422, 429].includes(response.status)) {
        dispatched = false;
        throw new LinkspanError(response.status === 401 || response.status === 403 ? "authentication_failed"
          : response.status === 429 ? "resource_exhausted" : "invalid_argument",
        "The TURN service rejected the request.", { outcome: "not_sent" });
      }
      throw unknown();
    }
    if (expectedStatus === 204) return undefined;
    if (Number(response.headers.get("content-length")) > CLOUDFLARE_TURN_LIMITS.responseBytes) throw unknown();
    reader = response.body?.getReader();
    if (reader === undefined) throw unknown();
    let size = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const chunk = await scope.wait(reader.read());
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > CLOUDFLARE_TURN_LIMITS.responseBytes) throw unknown();
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (dispatched) throw unknown();
    if (error instanceof LinkspanError) throw new LinkspanError(error.code, error.message, { outcome: "not_sent" });
    throw new LinkspanError("unavailable", "TURN credentials could not be accessed.", { outcome: "not_sent" });
  } finally {
    // Never wait indefinitely for a response body's producer during retirement.
    if (reader !== undefined) void reader.cancel().catch(() => undefined);
    else if (response?.body !== null && response?.body !== undefined) void response.body.cancel().catch(() => undefined);
    scope.dispose();
  }
}

function parseMaterial(value: unknown): readonly TurnIceServer[] {
  if (value === null || typeof value !== "object" || !Array.isArray((value as { iceServers?: unknown }).iceServers)) throw invalid();
  const raw = (value as { iceServers: unknown[] }).iceServers;
  if (raw.length < 1 || raw.length > 8) throw invalid();
  const result: TurnIceServer[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") throw invalid();
    const server = item as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = typeof server.urls === "string" ? [server.urls] : server.urls;
    if (!Array.isArray(urls) || urls.length < 1 || urls.length > 16 || urls.some(url => typeof url !== "string" || url.length > 512)) throw invalid();
    const turn = urls.filter((url: string) => /^turns?:/u.test(url));
    if (turn.length === 0) {
      if (urls.some(url => !/^stun:stun\.cloudflare\.com:(?:3478|53)$/u.test(url))) throw invalid();
      continue;
    }
    if (turn.length !== urls.length || turn.some(url => !/^turns?:turn\.cloudflare\.com:(?:3478|443|80|5349)\?transport=(?:udp|tcp)$/u.test(url)
      || url.startsWith("turns:") && !url.endsWith("transport=tcp"))
      || !validField(server.username, 256) || !validField(server.credential, 256)) throw invalid();
    result.push(Object.freeze({ urls: Object.freeze([...new Set(turn)]), username: server.username, credential: server.credential }));
  }
  if (result.length < 1 || result.length > 4) throw invalid();
  return Object.freeze(result);
}

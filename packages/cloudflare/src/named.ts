import { createHash, randomBytes } from "node:crypto";
import { createOperationScope, LinkspanError, type OperationOptions } from "@jokoagent/linkspan-core";

export interface CloudflareNamedResource {
  readonly accountId: string;
  readonly tunnelId: string;
  readonly requestId: string;
  readonly name: string;
  readonly createdByHost: true;
}
export interface CloudflareNamedCredentials { readonly resource: CloudflareNamedResource; readonly tunnelSecret: string }
export type CloudflareNamedCandidate = Omit<CloudflareNamedResource, "createdByHost"> & { readonly createdByHost: false };
export interface CloudflareApiOptions extends OperationOptions {
  readonly accountId: string;
  readonly apiToken: string;
}
function validate(options: CloudflareApiOptions): void {
  if (!/^[a-f0-9]{32}$/u.test(options.accountId) || typeof options.apiToken !== "string" || options.apiToken.length < 16 || options.apiToken.length > 4096 || /[\x00\r\n]/u.test(options.apiToken)) throw new LinkspanError("invalid_argument", "A bounded publisher account and resource API token are required.");
}
function nameFor(requestId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(requestId)) throw new LinkspanError("invalid_argument", "A stable host operation identity is required.");
  return `linkspan-${createHash("sha256").update(requestId).digest("hex").slice(0, 40)}`;
}
async function request(options: CloudflareApiOptions, path: string, method: "GET" | "POST" | "DELETE", body?: object): Promise<unknown> {
  validate(options);
  const scope = createOperationScope({ ...(options.signal === undefined ? {} : { signal: options.signal }), deadline: Math.min(options.deadline ?? Infinity, Date.now() + 15_000) });
  let sent = false;
  try {
    scope.check(); sent = true;
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${options.accountId}/cfd_tunnel${path}`, { method, redirect: "error", headers: { authorization: `Bearer ${options.apiToken}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: scope.signal });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      const denied = response.status === 401 || response.status === 403;
      throw new LinkspanError(denied ? "authentication_failed" : method === "GET" ? "transport_error" : "outcome_unknown", "The named-tunnel resource API did not confirm the operation.", { outcome: denied || method === "GET" ? "not_sent" : "unknown" });
    }
    const reader = response.body?.getReader(); let text = ""; let bytes = 0;
    if (reader) { const decoder = new TextDecoder(); try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 65_536) throw new Error(); text += decoder.decode(chunk.value, { stream: true }); } text += decoder.decode(); } finally { reader.releaseLock(); } }
    const value = JSON.parse(text) as { success?: boolean; result?: unknown };
    if (value.success !== true) throw new LinkspanError("transport_error", "The resource API did not confirm success.");
    return value.result;
  } catch (error) {
    if (error instanceof LinkspanError && ["authentication_failed", "outcome_unknown"].includes(error.code)) throw error;
    throw new LinkspanError(sent && method !== "GET" ? "outcome_unknown" : "transport_error", "The resource outcome could not be confirmed; query the original resource before retrying.", { outcome: sent && method !== "GET" ? "unknown" : "not_sent" });
  } finally { scope.dispose(); }
}
/** Generate before the host journals the create intent. Preserve this secret in
 * the host vault so a lost create response never requires a new identity. */
export function createNamedTunnelSecret(): string { return randomBytes(32).toString("base64"); }

export async function findNamedTunnel(options: CloudflareApiOptions & { readonly requestId: string; readonly expectedResource?: CloudflareNamedResource }): Promise<CloudflareNamedResource | CloudflareNamedCandidate | null> {
  const name = nameFor(options.requestId);
  if (options.expectedResource !== undefined) {
    const expected = options.expectedResource;
    if (expected.createdByHost !== true || expected.requestId !== options.requestId || expected.accountId !== options.accountId || expected.name !== name || !/^[a-f0-9-]{36}$/u.test(expected.tunnelId)) throw new LinkspanError("invalid_argument", "The original host receipt does not match this tunnel operation.");
    const value = await request(options, `/${expected.tunnelId}`, "GET") as { id?: string; name?: string; config_src?: string } | null;
    if (value === null) return null;
    if (value.id !== expected.tunnelId || value.name !== name || value.config_src !== "local") throw new LinkspanError("identity_mismatch", "The original named-tunnel resource identity changed.");
    return Object.freeze({ ...expected });
  }
  const value = await request(options, `?name=${encodeURIComponent(name)}&is_deleted=false`, "GET");
  if (!Array.isArray(value)) throw new LinkspanError("protocol_error", "The resource lookup returned an invalid result.");
  const matches = value.filter((item: unknown): item is { id: string; name: string; config_src: string } => !!item && typeof item === "object" && (item as { name?: unknown }).name === name);
  if (matches.length > 1) throw new LinkspanError("outcome_unknown", "More than one resource matches the original host operation.", { outcome: "unknown" });
  const match = matches[0];
  if (!match) return null;
  if (typeof match.id !== "string" || !/^[a-f0-9-]{36}$/u.test(match.id) || match.config_src !== "local") throw new LinkspanError("protocol_error", "The existing tunnel is not the expected locally managed carrier.");
  return Object.freeze({ accountId: options.accountId, tunnelId: match.id, requestId: options.requestId, name, createdByHost: false });
}

/** This endpoint never creates DNS, Access policies, paid subscriptions or a
 * remote ingress configuration. DNS ownership remains a separate host action. */
export async function createNamedTunnel(options: CloudflareApiOptions & { readonly requestId: string; readonly tunnelSecret: string; readonly expectedResource?: CloudflareNamedResource }): Promise<CloudflareNamedCredentials> {
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(options.tunnelSecret)) throw new LinkspanError("invalid_argument", "A previously journaled 32-byte tunnel secret is required.");
  const existing = await findNamedTunnel(options);
  if (existing?.createdByHost === true) return Object.freeze({ resource: existing, tunnelSecret: options.tunnelSecret });
  if (existing || options.expectedResource !== undefined) throw new LinkspanError("outcome_unknown", "A matching name without the original creation receipt cannot establish ownership or authorize another create.", { outcome: "unknown" });
  const name = nameFor(options.requestId);
  const value = await request(options, "", "POST", { name, tunnel_secret: options.tunnelSecret, config_src: "local" }) as { id?: unknown; name?: unknown; config_src?: unknown } | null;
  if (!value || typeof value.id !== "string" || !/^[a-f0-9-]{36}$/u.test(value.id) || value.name !== name || value.config_src !== "local") throw new LinkspanError("outcome_unknown", "The created tunnel identity could not be confirmed.", { outcome: "unknown" });
  return Object.freeze({ resource: Object.freeze({ accountId: options.accountId, tunnelId: value.id, requestId: options.requestId, name, createdByHost: true as const }), tunnelSecret: options.tunnelSecret });
}

export async function deleteNamedTunnel(options: CloudflareApiOptions & { readonly resource: CloudflareNamedResource }): Promise<void> {
  const resource = options.resource;
  if (resource.createdByHost !== true || resource.accountId !== options.accountId || resource.name !== nameFor(resource.requestId)) throw new LinkspanError("invalid_argument", "Only a matching host-owned tunnel can be deleted.");
  const current = await findNamedTunnel({ ...options, requestId: resource.requestId, expectedResource: resource });
  if (!current) return;
  if (current.tunnelId !== resource.tunnelId) throw new LinkspanError("identity_mismatch", "The resource identity changed; cleanup was refused.");
  await request(options, `/${resource.tunnelId}`, "DELETE");
}

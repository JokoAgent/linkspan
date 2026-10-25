import { createHash } from "node:crypto";
import { createOperationScope, LinkspanError, type OperationOptions } from "@jokoagent/linkspan-core";
import { boundedText, invalid, publicOrigin } from "./runtime.js";

export interface NetbirdResourceOptions extends OperationOptions {
  readonly managementUrl: string;
  readonly apiToken: string;
  readonly requestId: string;
  readonly mode: "http" | "tls" | "tcp" | "udp";
  readonly domain: string;
  readonly peerId: string;
  readonly targetPort: number;
  /** Public reverse-proxy listen_port. Omit/0 requests cluster allocation;
   * targetPort remains the independent peer-side embedded listener. */
  readonly listenPort?: number;
  readonly expectedResource?: NetbirdPublicResource;
}
export type NetbirdPublicCandidate = Omit<NetbirdPublicResource, "createdByHost"> & { readonly createdByHost: false };
export interface NetbirdPublicResource {
  readonly provider: "netbird";
  readonly requestId: string;
  readonly id: string;
  readonly name: string;
  readonly managementUrl: string;
  readonly createdByHost: true;
  /** Confirmed public L4 listen_port, distinct from targetPort. */
  readonly listenPort?: number;
}
const nameFor = (requestId: string): string => `linkspan-${createHash("sha256").update(boundedText(requestId, "host operation identity", 128)).digest("hex").slice(0, 32)}`;
async function api(options: NetbirdResourceOptions, method: "GET" | "POST" | "DELETE", suffix = "", body?: object): Promise<unknown> {
  const origin = publicOrigin(options.managementUrl);
  boundedText(options.apiToken, "publisher resource token", 8192);
  const scope = createOperationScope({ ...(options.signal === undefined ? {} : { signal: options.signal }), deadline: Math.min(options.deadline ?? Infinity, Date.now() + 15_000) });
  let sent = false;
  try {
    scope.check(); sent = true;
    const response = await fetch(`${origin}/api/reverse-proxies/services${suffix}`, { method, redirect: "error", signal: scope.signal, headers: { authorization: `Token ${options.apiToken}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel(); const denied = response.status === 401 || response.status === 403;
      throw new LinkspanError(denied ? "authentication_failed" : method === "GET" ? "transport_error" : "outcome_unknown", "The public proxy resource API did not confirm the operation.", { outcome: denied || method === "GET" ? "not_sent" : "unknown" });
    }
    if (method === "DELETE" || response.status === 204) { await response.body?.cancel(); return null; }
    if (!response.body) throw new Error();
    let bytes = 0; const parts: Uint8Array[] = [];
    for await (const part of response.body) { bytes += part.byteLength; if (bytes > 1024 * 1024) throw new Error(); parts.push(part); }
    return JSON.parse(Buffer.concat(parts).toString("utf8"));
  } catch (error) {
    if (error instanceof LinkspanError && ["authentication_failed", "outcome_unknown"].includes(error.code)) throw error;
    throw new LinkspanError(sent && method !== "GET" ? "outcome_unknown" : "transport_error", "The proxy resource outcome could not be confirmed; query the original host operation.", { outcome: sent && method !== "GET" ? "unknown" : "not_sent" });
  } finally { scope.dispose(); }
}
function validateResource(value: unknown, options: NetbirdResourceOptions): NetbirdPublicCandidate {
  if (!value || typeof value !== "object") throw new LinkspanError("protocol_error", "The public proxy resource response is invalid.");
  const v = value as { id?: string; name?: string; mode?: string; private?: boolean; domain?: string; listen_port?: number; auth?: Record<string, unknown>; targets?: { target_type?: string; target_id?: string; port?: number; protocol?: string }[] };
  const noAuth = v.auth && Object.values(v.auth).every(auth => auth === null || auth === undefined || (Array.isArray(auth) && auth.length === 0) || (typeof auth === "object" && (auth as { enabled?: boolean }).enabled === false));
  const target = v.targets?.[0];
  if (!v.id || v.name !== nameFor(options.requestId) || v.mode !== options.mode || v.private === true || v.domain !== options.domain || !noAuth || v.targets?.length !== 1 || target?.target_type !== "peer" || target.target_id !== options.peerId || target.port !== options.targetPort || target.protocol !== (options.mode === "http" ? "http" : options.mode === "udp" ? "udp" : "tcp")) throw new LinkspanError("identity_mismatch", "The proxy is not the exact owned public carrier with visitor authentication disabled.");
  if (options.mode !== "http" && (!Number.isInteger(v.listen_port) || v.listen_port! < 1 || v.listen_port! > 65535 || (options.listenPort !== undefined && options.listenPort > 0 && options.listenPort !== v.listen_port) || (options.expectedResource?.listenPort !== undefined && options.expectedResource.listenPort !== v.listen_port))) throw new LinkspanError("identity_mismatch", "The proxy did not confirm its exact public listening port.");
  return Object.freeze({ provider: "netbird", requestId: options.requestId, id: v.id, name: v.name, managementUrl: publicOrigin(options.managementUrl), createdByHost: false, ...(options.mode === "http" ? {} : { listenPort: v.listen_port! }) });
}
function validate(options: NetbirdResourceOptions): void {
  if (!["http", "tls", "tcp", "udp"].includes(options.mode) || !Number.isInteger(options.targetPort) || options.targetPort < 1 || options.targetPort > 65535 || !/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/u.test(options.domain) || (options.listenPort !== undefined && (!Number.isInteger(options.listenPort) || options.listenPort < 0 || options.listenPort > 65535))) invalid("The public proxy mode, domain or target port is invalid.");
  boundedText(options.peerId, "dedicated connector peer identity", 128);
}
export async function findNetbirdPublicResource(options: NetbirdResourceOptions): Promise<NetbirdPublicResource | NetbirdPublicCandidate | null> {
  validate(options);
  if (options.expectedResource !== undefined) {
    const expected = options.expectedResource;
    if (expected.createdByHost !== true || expected.requestId !== options.requestId || expected.name !== nameFor(options.requestId) || expected.managementUrl !== publicOrigin(options.managementUrl)) invalid("The original proxy creation receipt does not match this operation.");
    const result = await api(options, "GET", `/${encodeURIComponent(boundedText(expected.id, "owned proxy identity", 128))}`);
    if (result === null) return null;
    if (validateResource(result, options).id !== expected.id) throw new LinkspanError("identity_mismatch", "The original proxy resource identity changed.");
    return Object.freeze({ ...expected });
  }
  const values = await api(options, "GET");
  if (!Array.isArray(values)) throw new LinkspanError("protocol_error", "The proxy resource listing is invalid.");
  const matches = values.filter(value => value && typeof value === "object" && value.name === nameFor(options.requestId));
  if (matches.length > 1) throw new LinkspanError("outcome_unknown", "Multiple proxy resources match the original host identity.", { outcome: "unknown" });
  return matches.length === 0 ? null : validateResource(matches[0], options);
}
export async function createNetbirdPublicResource(options: NetbirdResourceOptions): Promise<NetbirdPublicResource> {
  validate(options);
  const existing = await findNetbirdPublicResource(options);
  if (existing?.createdByHost === true) return existing;
  if (existing || options.expectedResource !== undefined) throw new LinkspanError("outcome_unknown", "A name-only proxy match cannot establish ownership or authorize a replacement create.", { outcome: "unknown" });
  const value = await api(options, "POST", "", { name: nameFor(options.requestId), domain: options.domain, mode: options.mode, enabled: true, private: false, auth: {},
    ...(options.mode === "http" ? {} : { listen_port: options.listenPort ?? 0 }),
    targets: [{ target_type: "peer", target_id: options.peerId, port: options.targetPort, protocol: options.mode === "http" ? "http" : options.mode === "udp" ? "udp" : "tcp", enabled: true,
      ...(options.mode === "http" ? { path: "/", access_action: "bypass", options: { path_rewrite: "preserve" } } : {}) }] });
  try { return Object.freeze({ ...validateResource(value, options), createdByHost: true }); } catch { throw new LinkspanError("outcome_unknown", "The created proxy identity could not be confirmed.", { outcome: "unknown" }); }
}
export async function deleteNetbirdPublicResource(options: NetbirdResourceOptions & { readonly resource: NetbirdPublicResource }): Promise<void> {
  const resource = options.resource;
  if (!resource.createdByHost || resource.provider !== "netbird" || resource.requestId !== options.requestId || resource.name !== nameFor(options.requestId) || resource.managementUrl !== publicOrigin(options.managementUrl)) invalid("Only the original owned proxy resource can be deleted.");
  boundedText(resource.id, "proxy resource identity", 128);
  const current = await api(options, "GET", `/${encodeURIComponent(resource.id)}`);
  if (current === null) return;
  if (validateResource(current, { ...options, expectedResource: resource }).id !== resource.id) throw new LinkspanError("identity_mismatch", "The proxy resource identity changed.");
  await api(options, "DELETE", `/${encodeURIComponent(resource.id)}`);
}

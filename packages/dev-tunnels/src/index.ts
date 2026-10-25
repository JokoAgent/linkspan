import { createHash } from "node:crypto";
import { LinkspanError, createOperationScope, type OperationOptions } from "@jokoagent/linkspan-core";
import type { Connector, ConnectorConfig, ConnectorOptions, DevTunnelsConfig } from "@jokoagent/linkspan-connector-runtime";
import { boundedText, boundedClose, invalid, publicOrigin, startWithLifecycle } from "@jokoagent/linkspan-connector-runtime/runtime";

interface Tunnel { tunnelId?: string; clusterId?: string; name?: string; labels?: string[]; accessTokens?: Record<string, string>; ports?: Port[]; accessControl?: { entries: object[] } }
interface Port { portNumber: number; protocol?: string; labels?: string[]; accessControl?: { entries: object[] }; portForwardingUris?: string[] }
function anonymousVisitors(control: { entries: object[] } | undefined): boolean {
  if (!control || !Array.isArray(control.entries)) return false;
  const entries = control.entries as { type?: string; scopes?: string[]; subjects?: unknown[]; isDeny?: boolean; isInverse?: boolean }[];
  return entries.some(entry => entry.type === "Anonymous" && entry.scopes?.includes("connect") && entry.isDeny !== true && entry.isInverse !== true && (entry.subjects?.length ?? 0) === 0)
    && !entries.some(entry => entry.isDeny === true && entry.scopes?.includes("connect"));
}
interface Manager {
  enableEventsReporting: boolean;
  trace: (value: string) => void;
  getTunnel(tunnel: Tunnel, options?: object): Promise<Tunnel | null>;
  createTunnel(tunnel: Tunnel, options?: object): Promise<Tunnel>;
  deleteTunnel(tunnel: Tunnel, options?: object): Promise<boolean>;
  dispose(): Promise<void>;
}
async function readTunnel(manager: Manager, tunnel: Tunnel, options: object): Promise<Tunnel | null> {
  try { return await manager.getTunnel(tunnel, options); }
  catch (error) { if ((error as { response?: { status?: number } })?.response?.status === 404) return null; throw error; }
}
async function management(accessToken: string): Promise<Manager> {
  boundedText(accessToken, "publisher management token", 8192);
  const name = "@microsoft/dev-tunnels-management";
  const sdk = await import(name) as { TunnelManagementHttpClient: new (...args: unknown[]) => Manager };
  // Keep the official typed management client while bounding its HTTP adapter.
  // Provider diagnostics and arbitrary response bodies never escape this layer.
  const adapter = async (config: { url: string; method?: string; headers?: { toJSON?(): object }; data?: string }) => {
    const url = new URL(config.url);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".tunnels.api.visualstudio.com") || url.username || url.password) throw new Error("Unexpected Dev Tunnels management origin.");
    const response = await fetch(url, { method: config.method?.toUpperCase() ?? "GET", headers: (config.headers?.toJSON?.() ?? config.headers ?? {}) as HeadersInit, ...(config.data === undefined ? {} : { body: config.data }), redirect: "error", signal: AbortSignal.timeout(15_000) });
    let bytes = 0; const chunks: Uint8Array[] = [];
    const reader = response.body?.getReader();
    try { if (reader) for (;;) { const chunk = await reader.read(); if (chunk.done) break; bytes += chunk.value.byteLength; if (bytes > 256 * 1024) { await reader.cancel(); throw new Error("Dev Tunnels response exceeded its boundary."); } chunks.push(chunk.value); } }
    finally { reader?.releaseLock(); }
    const data = Buffer.concat(chunks).toString("utf8");
    const result = { status: response.status, statusText: response.statusText, data, headers: Object.fromEntries(response.headers.entries()), config };
    if (response.status >= 400) throw Object.assign(new Error("Dev Tunnels API rejected the operation."), { response: result, isAxiosError: true, config });
    return result;
  };
  const result = new sdk.TunnelManagementHttpClient({ name: "linkspan", version: "0.1.0" }, "2023-09-27-preview", async () => accessToken, undefined, undefined, adapter);
  result.enableEventsReporting = false; result.trace = () => {};
  return result;
}
const ownership = (requestId: string): string => {
  boundedText(requestId, "host request identity", 128);
  return `linkspan-${createHash("sha256").update(requestId).digest("hex").slice(0, 32)}`;
};
const anonymousAccess = () => ({ entries: [{ type: "Anonymous", subjects: [], scopes: ["connect"], isDeny: false }] });

export interface DevTunnelResource { readonly requestId: string; readonly tunnelId: string; readonly clusterId: string; readonly ownershipLabel: string; readonly port: number; readonly createdByHost: true }
export type DevTunnelCandidate = Omit<DevTunnelResource, "createdByHost"> & { readonly createdByHost: false };
export interface DevTunnelResourceOptions extends OperationOptions { readonly publisherAccessToken: string; readonly requestId: string; readonly clusterId: string; readonly port: number; readonly expectedResource?: DevTunnelResource }

function inspectResource(tunnel: Tunnel, options: DevTunnelResourceOptions): DevTunnelCandidate {
  const label = ownership(options.requestId);
  if (tunnel.tunnelId !== ownership(options.requestId) || tunnel.clusterId !== options.clusterId || !tunnel.labels?.includes(label) || tunnel.ports?.length !== 1 || tunnel.ports[0]?.portNumber !== options.port || tunnel.ports[0]?.protocol !== "http" || !anonymousVisitors(tunnel.accessControl) || !anonymousVisitors(tunnel.ports[0]?.accessControl)) throw new LinkspanError("identity_mismatch", "The Dev Tunnel is not the exact single-port resource with anonymous visitors enabled.");
  return Object.freeze({ requestId: options.requestId, tunnelId: tunnel.tunnelId, clusterId: options.clusterId, ownershipLabel: label, port: options.port, createdByHost: false });
}
function expectedLookup(options: DevTunnelResourceOptions): Tunnel {
  if (!/^[a-z0-9-]{1,64}$/u.test(options.clusterId)) invalid("The Dev Tunnels cluster identity is invalid.");
  const expected = options.expectedResource;
  if (expected === undefined) return { clusterId: options.clusterId, tunnelId: ownership(options.requestId), name: ownership(options.requestId) };
  if (expected.createdByHost !== true || expected.requestId !== options.requestId || expected.clusterId !== options.clusterId || expected.port !== options.port || expected.ownershipLabel !== ownership(options.requestId) || !/^[a-z0-9-]{1,128}$/u.test(expected.tunnelId)) invalid("The original Dev Tunnel receipt does not match this operation.");
  return { clusterId: expected.clusterId, tunnelId: expected.tunnelId };
}

/** A deterministic name plus ownership label makes a lost create response
 * queryable without reserving a second tunnel or renaming another user's one. */
export async function findDevTunnel(options: DevTunnelResourceOptions): Promise<DevTunnelResource | DevTunnelCandidate | null> {
  const lookup = expectedLookup(options);
  const manager = await management(options.publisherAccessToken);
  const scope = createOperationScope(options);
  try {
    const tunnel = await scope.wait(readTunnel(manager, lookup, { includePorts: true, includeAccessControl: true, followRedirects: false }));
    if (!tunnel) return null;
    const found = inspectResource(tunnel, options);
    if (options.expectedResource === undefined) return found;
    if (found.tunnelId !== options.expectedResource.tunnelId) throw new LinkspanError("identity_mismatch", "The original Dev Tunnel identity changed.");
    return Object.freeze({ ...options.expectedResource });
  } catch (error) { if (error instanceof LinkspanError) throw error; throw new LinkspanError("transport_error", "The Dev Tunnel ownership lookup failed."); }
  finally { scope.dispose(); await manager.dispose(); }
}

export async function createDevTunnel(options: DevTunnelResourceOptions): Promise<{ readonly resource: DevTunnelResource; readonly hostAccessToken: string; readonly publicOrigin: string }> {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) invalid("A valid single forwarded port is required.");
  const manager = await management(options.publisherAccessToken);
  const scope = createOperationScope(options);
  let sent = false;
  try {
    const lookup = expectedLookup(options);
    let tunnel = await scope.wait(readTunnel(manager, lookup, { includePorts: true, includeAccessControl: true, tokenScopes: ["host"], followRedirects: false }));
    if (tunnel && options.expectedResource === undefined) throw new LinkspanError("outcome_unknown", "A name/label-only match cannot establish ownership or authorize a replacement create.", { outcome: "unknown" });
    if (!tunnel && options.expectedResource !== undefined) throw new LinkspanError("outcome_unknown", "The original Dev Tunnel is missing; a recovery lookup cannot create a replacement.", { outcome: "unknown" });
    if (!tunnel) {
      scope.check(); sent = true;
      tunnel = await scope.wait(manager.createTunnel({ ...lookup, labels: [ownership(options.requestId)], accessControl: anonymousAccess(), ports: [{ portNumber: options.port, protocol: "http", labels: [ownership(options.requestId)], accessControl: anonymousAccess() }] }, { includePorts: true, includeAccessControl: true, tokenScopes: ["host"], followRedirects: false, forceRename: false }));
    }
    const candidate = inspectResource(tunnel, options);
    if (options.expectedResource !== undefined && candidate.tunnelId !== options.expectedResource.tunnelId) throw new LinkspanError("identity_mismatch", "The original Dev Tunnel identity changed.");
    const resource: DevTunnelResource = Object.freeze({ ...candidate, createdByHost: true });
    const token = tunnel.accessTokens?.host;
    const uri = tunnel.ports?.[0]?.portForwardingUris?.find(value => value.startsWith("https://"));
    if (!token || !uri) throw new LinkspanError("outcome_unknown", "The resource exists but its host token or public web address was not confirmed.", { outcome: "unknown" });
    return Object.freeze({ resource, hostAccessToken: token, publicOrigin: new URL(uri).origin });
  } catch (error) {
    if (error instanceof LinkspanError && (error.code === "outcome_unknown" || (!sent && error.code === "identity_mismatch"))) throw error;
    throw new LinkspanError(sent ? "outcome_unknown" : "transport_error", "The Dev Tunnel operation did not confirm; query its original ownership label before retrying.", { outcome: sent ? "unknown" : "not_sent" });
  } finally { scope.dispose(); await manager.dispose(); }
}

export async function deleteDevTunnel(options: DevTunnelResourceOptions & { readonly resource: DevTunnelResource }): Promise<void> {
  const resource = options.resource;
  if (!resource.createdByHost || resource.requestId !== options.requestId || resource.clusterId !== options.clusterId || resource.ownershipLabel !== ownership(options.requestId) || resource.port !== options.port) invalid("Only the exact owned Dev Tunnel can be deleted.");
  const manager = await management(options.publisherAccessToken); const scope = createOperationScope(options);
  try {
    const tunnel = await scope.wait(readTunnel(manager, { tunnelId: resource.tunnelId, clusterId: resource.clusterId }, { includePorts: true, includeAccessControl: true, followRedirects: false }));
    if (!tunnel) return;
    if (inspectResource(tunnel, options).tunnelId !== resource.tunnelId) throw new LinkspanError("identity_mismatch", "The Dev Tunnel identity changed.");
    await scope.wait(manager.deleteTunnel({ tunnelId: resource.tunnelId, clusterId: resource.clusterId }, { followRedirects: false }));
  } catch (error) { if (error instanceof LinkspanError && error.code === "identity_mismatch") throw error; throw new LinkspanError("outcome_unknown", "Dev Tunnel cleanup was not confirmed.", { outcome: "unknown" }); }
  finally { scope.dispose(); await manager.dispose(); }
}

/** Exact-ID read-only material refresh. A missing original resource always fails
 * and can never fall through to creation, renaming, or another tunnel. */
export async function getDevTunnelMaterial(options: Omit<DevTunnelResourceOptions, "clusterId" | "port" | "expectedResource"> & { readonly resource: DevTunnelResource }): Promise<{ readonly resource: DevTunnelResource; readonly hostAccessToken: string; readonly publicOrigin: string }> {
  return createDevTunnel({ ...options, clusterId: options.resource.clusterId, port: options.resource.port, expectedResource: options.resource });
}

/** The SDK's protected forwarding hook binds the approved remote port to the
 * fixed bridge. Provider-refreshed port lists cannot select other local ports. */
export async function start(input: ConnectorConfig, options: ConnectorOptions): Promise<Connector> {
  if (input.provider !== "dev-tunnels") invalid("The Dev Tunnels adapter requires its own typed configuration.");
  const config = input as DevTunnelsConfig;
  boundedText(config.tunnelId, "tunnel ID", 128); boundedText(config.clusterId, "cluster ID", 64); boundedText(config.hostAccessToken, "host access token", 8192); publicOrigin(config.publicOrigin);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) invalid("The approved forwarded port is invalid.");
  return startWithLifecycle(config, options, "http", async bridge => {
    const manager = await management(`tunnel ${config.hostAccessToken}`);
    const name = "@microsoft/dev-tunnels-connections";
    const sdk = await import(name) as { TunnelRelayTunnelHost: new (...args: unknown[]) => any; ConnectionStatus: { Disconnected: string } };
    const forwarders: { dispose(): void }[] = [];
    class FixedOriginHost extends sdk.TunnelRelayTunnelHost {
      async forwardPort(pfs: any, port: Port): Promise<void> {
        if (port.portNumber !== config.port) return;
        if (pfs.localForwardedPorts.find((value: { localPort: number }) => value.localPort === bridge.port)) return;
        const forwarder = await pfs.forwardFromRemotePort("127.0.0.1", config.port, bridge.host, bridge.port);
        if (forwarder) forwarders.push(forwarder);
      }
    }
    const host = new FixedOriginHost(manager, () => {});
    host.enableE2EEncryption = false;
    host.retryingTunnelConnection((event: { retry: boolean }) => { event.retry = false; });
    host.forwardedPortConnecting((event: { port: number; transformPromise?: Promise<null> }) => { if (event.port !== config.port) event.transformPromise = Promise.resolve(null); });
    let resolveClosed!: () => void; const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    host.connectionStatusChanged((event: { status: string }) => { if (event.status === sdk.ConnectionStatus.Disconnected) resolveClosed(); });
    try {
      await host.connect({ tunnelId: config.tunnelId, clusterId: config.clusterId, accessTokens: { host: config.hostAccessToken }, ports: [{ portNumber: config.port, protocol: "http", accessControl: anonymousAccess() }], accessControl: anonymousAccess() }, { enableRetry: false, keepAliveIntervalInSeconds: 15 });
    } catch (error) { await host.dispose(); await manager.dispose(); throw error; }
    return { publicOrigin: config.publicOrigin, resource: { provider: "dev-tunnels", requestId: options.requestId, id: `${config.clusterId}:${config.tunnelId}:${config.port}`, createdByHost: false }, closed,
      async close() { for (const forwarder of forwarders) forwarder.dispose(); try { await host.dispose(); } finally { await manager.dispose(); resolveClosed(); } } };
  });
}

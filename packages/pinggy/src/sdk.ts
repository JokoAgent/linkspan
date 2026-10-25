import { createHash } from "node:crypto";
import type { ConnectorResource } from "@jokoagent/linkspan-connector-runtime";
import type { PinggyConfig } from "@jokoagent/linkspan-connector-runtime";
import { invalid, publicOrigin } from "@jokoagent/linkspan-connector-runtime/runtime";

export interface Tunnel { start(): Promise<string[]>; stop(): Promise<void>; setWorkerErrorCallback(callback: () => void): void; setTunnelDisconnectedCallback(callback: () => void): void }
export interface Sdk { pinggy: { setDebugLogging(enabled: boolean): void; createTunnel(config: object): Promise<Tunnel> } }

export function pinggyByteMode(config: PinggyConfig): { bridge: "http" | "tls"; scheme: string } {
  if (config.mode === "tlstcp") {
    if (config.budget?.paidEnabled !== true) invalid("Pinggy TLSTCP requires explicit consent to an existing Pro plan.");
    if (config.tlstcpEndpoint !== "tcp" && config.tlstcpEndpoint !== "tls") invalid("Select the raw TCP or supplier-terminated TLS endpoint of the TLSTCP carrier.");
    return { bridge: config.tlstcpEndpoint === "tls" ? "http" : "tls", scheme: `${config.tlstcpEndpoint}:` };
  }
  if (config.tlstcpEndpoint !== undefined) invalid("The TLSTCP endpoint selection applies only to the TLSTCP mode.");
  return { bridge: config.mode === "http" ? "http" : "tls", scheme: config.mode === "http" ? "https:" : `${config.mode}:` };
}
export function selectPinggyOrigin(addresses: readonly string[], config: PinggyConfig): string {
  const { scheme } = pinggyByteMode(config);
  for (const value of addresses) try {
    const url = new URL(value);
    if (url.protocol !== scheme) continue;
    const origin = publicOrigin(value.replace(/^[a-z]+:/u, "https:"));
    if (config.publicOrigin === undefined || origin === publicOrigin(config.publicOrigin)) return origin;
  } catch {}
  throw new Error("The assigned Pinggy endpoint differs from the selected public origin and transport mode.");
}
export function selectPinggyDatagramEndpoint(addresses: readonly string[], expected: { readonly publicHost?: string; readonly publicPort?: number }): { publicHost: string; publicPort: number } {
  for (const value of addresses) try {
    const url = new URL(value);
    const publicHost = url.hostname.replace(/^\[|\]$/gu, "");
    const publicPort = Number(url.port);
    if (url.protocol !== "udp:" || url.username || url.password || url.search || url.hash || (url.pathname !== "" && url.pathname !== "/") || !publicHost || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) continue;
    if ((expected.publicHost !== undefined || expected.publicPort !== undefined) && (publicHost.toLowerCase() !== expected.publicHost?.toLowerCase() || publicPort !== expected.publicPort)) continue;
    return { publicHost, publicPort };
  } catch {}
  throw new Error("The assigned Pinggy UDP endpoint differs from the selected public address.");
}

/** One explicit SDK forwarding rule, never a provider-selected local target. */
export async function openSdkTunnel(sdk: Sdk, input: {
  readonly type: "http" | "tls" | "tcp" | "tlstcp" | "udp";
  readonly address: string;
  readonly requestId: string;
  readonly token?: string;
  readonly listenAddress?: string;
  readonly signal?: AbortSignal;
  readonly onResource?: (resource: ConnectorResource) => void;
}) {
  input.signal?.throwIfAborted();
  sdk.pinggy.setDebugLogging(false);
  const tunnel = await sdk.pinggy.createTunnel({ version: "1.0", name: "Linkspan encrypted carrier", configId: input.requestId,
    forwarding: [{ type: input.type, address: input.address, ...(input.listenAddress === undefined ? {} : { listenAddress: input.listenAddress }) }],
    ...(input.token === undefined ? {} : { token: input.token }), httpsOnly: input.type === "http", autoReconnect: false,
    keepAliveInterval: 15, webDebugger: "", basicAuth: [], bearerTokenAuth: [], optional: { noTui: true } });
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve;
    tunnel.setWorkerErrorCallback(() => reject(new Error("The Pinggy carrier disconnected.")));
    tunnel.setTunnelDisconnectedCallback(resolve);
  });
  void closed.catch(() => {});
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => { await tunnel.stop(); resolveClosed(); })();
  const cancel = () => { void close().catch(() => {}); };
  input.signal?.addEventListener("abort", cancel, { once: true });
  void closed.finally(() => input.signal?.removeEventListener("abort", cancel)).catch(() => {});
  const resource: ConnectorResource = Object.freeze({ provider: "pinggy", requestId: input.requestId,
    id: `${input.type === "udp" ? "udp" : "pinggy"}:${createHash("sha256").update(input.requestId).digest("hex")}`, processId: process.pid, createdByHost: true });
  try {
    input.signal?.throwIfAborted();
    const receipt = input.onResource?.(resource) as unknown;
    if (receipt !== null && typeof receipt === "object" && "then" in receipt) { void Promise.resolve(receipt).catch(() => {}); throw new Error("The host resource receipt must be synchronous."); }
    const addresses = await tunnel.start();
    if (!Array.isArray(addresses) || addresses.length > 16 || addresses.some(value => typeof value !== "string" || value.length > 2048)) throw new Error("The Pinggy address response exceeded its boundary.");
    input.signal?.throwIfAborted();
    return { addresses, resource, closed, close };
  } catch (error) { await close(); throw error; }
}

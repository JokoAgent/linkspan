import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Connector, ConnectorConfig, ConnectorOptions, PinggyConfig } from "@jokoagent/linkspan-connector-runtime";
import { boundedText, invalid, publicOrigin, startWithLifecycle } from "@jokoagent/linkspan-connector-runtime/runtime";
import { verifyPinggySdk } from "./prepare.js";
import { startSsh } from "./ssh.js";
export { preparePinggySdk, verifyPinggySdk } from "./prepare.js";
interface Tunnel { start(): Promise<string[]>; stop(): Promise<void>; setWorkerErrorCallback(callback: () => void): void; setTunnelDisconnectedCallback(callback: () => void): void }
interface Sdk { pinggy: { setDebugLogging(enabled: boolean): void; createTunnel(config: object): Promise<Tunnel> } }

export async function start(input: ConnectorConfig, options: ConnectorOptions): Promise<Connector> {
  if (input.provider !== "pinggy") invalid("The Pinggy adapter requires its own typed configuration.");
  const config = input as PinggyConfig;
  if (!["http", "tls"].includes(config.mode)) invalid("The Pinggy mode is unsupported.");
  if (config.token !== undefined) boundedText(config.token, "publisher tunnel token");
  if (config.mode === "tls" && config.publicOrigin === undefined) invalid("The TLS carrier needs a certificate-matching host origin.");
  if (config.publicOrigin !== undefined) publicOrigin(config.publicOrigin);
  if (config.runtime === "ssh") return startSsh(config, options);
  if (config.runtime !== "sdk" || config.sdkDirectory === undefined) invalid("Select and prepare the explicit Pinggy SDK or SSH runtime.");
  await verifyPinggySdk(config.sdkDirectory);
  const bounded = config.budget.paidEnabled ? config : { ...config, budget: { ...config.budget, maximumSessionMs: Math.min(config.budget.maximumSessionMs, 3_600_000) } };
  return startWithLifecycle(bounded, options, config.mode === "http" ? "http" : "tls", async bridge => {
    const sdk = await import(pathToFileURL(join(config.sdkDirectory!, "dist/index.js")).href) as Sdk;
    sdk.pinggy.setDebugLogging(false);
    const tunnel = await sdk.pinggy.createTunnel({ version: "1.0", name: "Linkspan encrypted carrier", configId: options.requestId, forwarding: [{ type: config.mode, address: bridge.address }], ...(config.token === undefined ? {} : { token: config.token }), httpsOnly: true, autoReconnect: false, keepAliveInterval: 15, webDebugger: "", basicAuth: [], bearerTokenAuth: [], optional: { noTui: true } });
    let resolveClosed!: () => void; let rejectClosed!: () => void;
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = () => reject(new Error("The Pinggy carrier disconnected.")); });
    void closed.catch(() => {}); tunnel.setWorkerErrorCallback(rejectClosed); tunnel.setTunnelDisconnectedCallback(resolveClosed);
    let addresses: string[];
    try { addresses = await tunnel.start(); } catch (error) { await tunnel.stop(); throw error; }
    const origin = config.publicOrigin ?? addresses.find(value => value.startsWith("https://"));
    if (!origin) { await tunnel.stop(); throw new Error(); }
    if (!addresses.some(value => { try { return publicOrigin(value.replace(/^tls:/u, "https:")) === publicOrigin(origin); } catch { return false; } })) { await tunnel.stop(); throw new Error("The assigned Pinggy endpoint differs from the selected public origin."); }
    return { publicOrigin: origin, resource: { provider: "pinggy", requestId: options.requestId, id: `pinggy:${createHash("sha256").update(options.requestId).digest("hex")}`, createdByHost: true }, closed,
      async close() { await tunnel.stop(); resolveClosed(); } };
  });
}

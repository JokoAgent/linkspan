import type { EventEmitter } from "node:events";
import type { Connector, ConnectorConfig, ConnectorOptions, LocaltunnelConfig } from "@jokoagent/linkspan-connector-runtime";
import { boundedText, invalid, publicOrigin, startWithLifecycle } from "@jokoagent/linkspan-connector-runtime/runtime";
interface Tunnel extends EventEmitter { readonly url: string; close(): void }
export async function start(input: ConnectorConfig, options: ConnectorOptions): Promise<Connector> {
  if (input.provider !== "localtunnel") invalid("The localtunnel adapter requires localtunnel configuration.");
  const config = input as LocaltunnelConfig;
  if (config.host !== undefined) publicOrigin(config.host);
  if (config.subdomain !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(config.subdomain)) invalid("The requested localtunnel name is invalid.");
  return startWithLifecycle(config, options, "http", async bridge => {
    const packageName = "localtunnel";
    const sdk = await import(packageName) as { default: (options: object) => Promise<Tunnel> };
    const tunnel = await sdk.default({ port: bridge.port, local_host: bridge.host, local_https: false, ...(config.host === undefined ? {} : { host: config.host }), ...(config.subdomain === undefined ? {} : { subdomain: config.subdomain }) });
    const closed = new Promise<void>((resolve, reject) => { tunnel.once("close", resolve); tunnel.on("error", () => reject(new Error("The public localtunnel carrier disconnected."))); });
    void closed.catch(() => {});
    try { publicOrigin(tunnel.url); } catch (error) { tunnel.close(); throw error; }
    return { publicOrigin: tunnel.url, resource: { provider: "localtunnel", requestId: options.requestId, id: tunnel.url, createdByHost: true }, closed, async close() { tunnel.close(); await closed; } };
  });
}

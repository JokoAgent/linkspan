import { LinkspanError } from "@jokoagent/linkspan-core";
import { reconcileZrokResource, startHelperConnector } from "./helpers.js";
import { reconcileConnectorResource as reconcileTransient } from "./runtime.js";
import type { Connector, ConnectorConfig, ConnectorOptions, ConnectorResource } from "./types.js";
export * from "./types.js";
export * from "./limits.js";
export { prepareConnectorHelper, verifyConnectorHelper } from "./artifacts.js";
export async function reconcileConnectorResource(config: ConnectorConfig, resource: ConnectorResource, options: { readonly requestId: string; readonly signal?: AbortSignal; readonly deadline?: number }): Promise<{ readonly state: "retired" | "outcome_unknown" }> {
  const known = await reconcileTransient(config, resource, options);
  if (known.state === "retired" || config.provider !== "zrok") return known;
  return reconcileZrokResource(config, resource, options);
}

/** Only the selected SDK package is resolved. Importing metadata starts nothing. */
export async function startConnector(config: ConnectorConfig, options: ConnectorOptions): Promise<Connector> {
  if (["funnel", "frp", "rathole", "bore", "netbird", "zrok", "pangolin"].includes(config.provider)) return startHelperConnector(config, options);
  const packages = { ngrok: "@jokoagent/linkspan-ngrok", ssh: "@jokoagent/linkspan-ssh", pinggy: "@jokoagent/linkspan-pinggy", "dev-tunnels": "@jokoagent/linkspan-dev-tunnels", localtunnel: "@jokoagent/linkspan-localtunnel" } as const;
  const name = packages[config.provider as keyof typeof packages];
  if (name === undefined) throw new LinkspanError("invalid_argument", "The selected connector is unknown.");
  let backend: { start(config: ConnectorConfig, options: ConnectorOptions): Promise<Connector> };
  try { backend = await import(name) as typeof backend; }
  catch { throw new LinkspanError("unavailable", "Install the explicitly selected Linkspan provider package before enabling this carrier."); }
  return backend.start(config, options);
}

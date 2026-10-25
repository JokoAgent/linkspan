import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Connector, ConnectorConfig, ConnectorOptions, PinggyConfig } from "@jokoagent/linkspan-connector-runtime";
import { boundedText, invalid, publicOrigin, startWithLifecycle } from "@jokoagent/linkspan-connector-runtime/runtime";
import { verifyPinggySdk } from "./prepare.js";
import { startSsh } from "./ssh.js";
import { openSdkTunnel, pinggyByteMode, selectPinggyOrigin, type Sdk } from "./sdk.js";
export { preparePinggySdk, verifyPinggySdk } from "./prepare.js";
export { startDatagram } from "./datagram.js";

export async function start(input: ConnectorConfig, options: ConnectorOptions): Promise<Connector> {
  if (input.provider !== "pinggy") invalid("The Pinggy adapter requires its own typed configuration.");
  const config = input as PinggyConfig;
  if (!["http", "tls", "tcp", "tlstcp"].includes(config.mode)) invalid("The Pinggy mode is unsupported.");
  if (config.token !== undefined) boundedText(config.token, "publisher tunnel token");
  if (config.mode !== "http" && config.publicOrigin === undefined) invalid("The TLS/TCP carrier needs a certificate-matching host origin.");
  if (config.publicOrigin !== undefined) publicOrigin(config.publicOrigin);
  const mode = pinggyByteMode(config);
  if (config.runtime === "ssh") return startSsh(config, options);
  if (config.runtime !== "sdk" || config.sdkDirectory === undefined) invalid("Select and prepare the explicit Pinggy SDK or SSH runtime.");
  await verifyPinggySdk(config.sdkDirectory);
  const bounded = config.budget.paidEnabled ? config : { ...config, budget: { ...config.budget, maximumSessionMs: Math.min(config.budget.maximumSessionMs, 3_600_000) } };
  return startWithLifecycle(bounded, options, mode.bridge, async (bridge, signal) => {
    const sdk = await import(pathToFileURL(join(config.sdkDirectory!, "dist/index.js")).href) as Sdk;
    const tunnel = await openSdkTunnel(sdk, { type: config.mode, address: bridge.address, requestId: options.requestId, signal,
      ...(config.token === undefined ? {} : { token: config.token }), ...(options.onResource === undefined ? {} : { onResource: options.onResource }) });
    try { return { publicOrigin: selectPinggyOrigin(tunnel.addresses, config), resource: tunnel.resource, closed: tunnel.closed, close: tunnel.close }; }
    catch (error) { await tunnel.close(); throw error; }
  });
}

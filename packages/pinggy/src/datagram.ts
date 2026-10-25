import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConnectorResource } from "@jokoagent/linkspan-connector-runtime";
import { boundedText, invalid } from "@jokoagent/linkspan-connector-runtime/runtime";
import { verifyPinggySdk } from "./prepare.js";
import { openSdkTunnel, selectPinggyDatagramEndpoint, type Sdk } from "./sdk.js";

/** Internal selected-provider boundary. The central UDP adapter owns socket,
 * packet/peer/traffic budgets, cancellation, expiry and native media authority. */
export async function startDatagram(config: { readonly runtime: "sdk"; readonly sdkDirectory: string; readonly token?: string; readonly publicHost?: string; readonly publicPort?: number }, options: {
  readonly requestId: string;
  readonly localAddress: string;
  readonly signal?: AbortSignal;
  readonly onResource?: (resource: ConnectorResource) => void;
}) {
  if (config.runtime !== "sdk") invalid("Pinggy UDP requires the explicitly prepared SDK runtime; SSH cannot carry UDP.");
  if (!/^127\.0\.0\.1:[0-9]{1,5}$/u.test(options.localAddress)) invalid("The UDP carrier requires a fixed loopback packet bridge.");
  if (config.token !== undefined) boundedText(config.token, "publisher tunnel token");
  options.signal?.throwIfAborted();
  await verifyPinggySdk(config.sdkDirectory);
  options.signal?.throwIfAborted();
  const sdk = await import(pathToFileURL(join(config.sdkDirectory, "dist/index.js")).href) as Sdk;
  const host = config.publicHost?.includes(":") ? `[${config.publicHost}]` : config.publicHost;
  const tunnel = await openSdkTunnel(sdk, { type: "udp", address: options.localAddress, ...(host === undefined ? {} : { listenAddress: `${host}:${config.publicPort}` }), requestId: options.requestId,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(config.token === undefined ? {} : { token: config.token }), ...(options.onResource === undefined ? {} : { onResource: options.onResource }) });
  try { return { ...selectPinggyDatagramEndpoint(tunnel.addresses, config), resource: tunnel.resource, closed: tunnel.closed, close: tunnel.close }; }
  catch (error) { await tunnel.close(); throw error; }
}

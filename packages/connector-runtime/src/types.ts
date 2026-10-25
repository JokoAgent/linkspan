import type { OperationOptions } from "@jokoagent/linkspan-core";

export type ConnectorProvider = "funnel" | "frp" | "rathole" | "bore" | "ssh" | "netbird" | "ngrok" | "zrok" | "pangolin" | "pinggy" | "dev-tunnels" | "localtunnel";

/** Public limits describe the carrier, never confer application authorization. */
export interface ConnectorLimits {
  readonly stability: "stable" | "beta" | "experimental";
  readonly free: boolean;
  readonly temporaryHostname: boolean;
  readonly serviceLevelAgreement: boolean;
  readonly maximumSessionMs?: number;
  readonly maximumRequestBytes?: number;
  readonly notes: readonly string[];
}

export interface ConnectorResource {
  readonly provider: ConnectorProvider;
  /** The stable host operation identity, also used for provider ownership labels. */
  readonly requestId: string;
  readonly id: string;
  readonly processId?: number;
  readonly executableSha256?: string;
  readonly createdByHost: boolean;
  /** A public provider handle, never a publishing/authentication secret. */
  readonly providerResourceId?: string;
  /** Public context/fingerprint binding the exact original provider owner. */
  readonly providerResourceOwner?: string;
}

/** Explicit consent for an existing paid account; this never purchases a plan. */
export interface CarrierBudget {
  readonly paidEnabled: boolean;
  readonly maximumSessionMs: number;
  /** Counts both directions at the host bridge; provider metering may differ. */
  readonly maximumBytes: number;
}

export interface ConnectorOptions extends OperationOptions {
  readonly requestId: string;
  /** A dedicated encrypted-carrier HTTPS listener, never a general host service. */
  readonly localOrigin: string;
  readonly originServerName: string;
  /** Bounded public certificate PEM file. Private endpoint keys are forbidden. */
  readonly originCaPool: string;
  readonly startupTimeoutMs?: number;
  /** Persist synchronously in the host's already reserved operation. */
  readonly onResource?: (resource: ConnectorResource) => void;
}

export interface Connector {
  readonly kind: ConnectorProvider;
  readonly requestId: string;
  readonly publicOrigin: string;
  readonly resource: ConnectorResource;
  readonly limits: ConnectorLimits;
  readonly closed: Promise<{ readonly reason: "stopped" | "exited"; readonly error?: string }>;
  close(): Promise<void>;
}

/** A release-prepared helper; runtime only verifies, never downloads or updates. */
export interface ConnectorHelper {
  readonly executable: string;
  readonly target: string;
  readonly version: string;
  readonly sha256: string;
}

interface BaseConfig { readonly budget: CarrierBudget }
export interface NgrokConfig extends BaseConfig {
  readonly provider: "ngrok";
  readonly mode: "http" | "tls" | "tcp";
  readonly authtoken: string;
  readonly domain?: string;
  readonly remoteAddress?: string;
  /** For TCP/TLS this must identify the certificate presented by the host. */
  readonly publicOrigin?: string;
}
export interface PinggyConfig extends BaseConfig {
  readonly provider: "pinggy";
  readonly mode: "http" | "tls" | "tcp" | "tlstcp";
  /** TLSTCP offers raw TCP and a supplier-terminated TLS wrapper. Select one. */
  readonly tlstcpEndpoint?: "tcp" | "tls";
  readonly token?: string;
  readonly publicOrigin?: string;
  /** Explicitly prepared SDK copy containing only this target's pinned native addon. */
  readonly runtime: "sdk" | "ssh";
  readonly sdkDirectory?: string;
  readonly serverHostKeySha256?: string;
  readonly serverAddress?: string;
}
export interface LocaltunnelConfig extends BaseConfig {
  readonly provider: "localtunnel";
  readonly host?: string;
  readonly subdomain?: string;
}
export interface SshConfig extends BaseConfig {
  readonly provider: "ssh";
  readonly host: string;
  readonly port?: number;
  readonly username: string;
  readonly privateKey?: string;
  readonly passphrase?: string;
  readonly password?: string;
  readonly hostKeySha256: string;
  readonly remoteBindAddress: string;
  readonly remotePort: number;
  readonly publicOrigin: string;
}
export interface FrpConfig extends BaseConfig {
  readonly provider: "frp";
  readonly helper: ConnectorHelper;
  readonly mode: "tcp" | "http" | "https";
  readonly serverAddress: string;
  readonly serverPort: number;
  readonly token: string;
  readonly serverName: string;
  readonly serverCaPool: string;
  readonly remotePort?: number;
  readonly publicOrigin: string;
}
export interface RatholeConfig extends BaseConfig {
  readonly provider: "rathole";
  readonly helper: ConnectorHelper;
  readonly remoteAddress: string;
  readonly serviceName: string;
  readonly token: string;
  readonly transport: { readonly type: "noise"; readonly remotePublicKey: string } | { readonly type: "tls"; readonly hostname: string; readonly trustedRoot: string };
  readonly publicOrigin: string;
}
export interface BoreConfig extends BaseConfig {
  readonly provider: "bore";
  readonly helper: ConnectorHelper;
  readonly serverAddress: string;
  readonly remotePort: number;
  readonly secret?: string;
  readonly publicOrigin: string;
}
export interface FunnelConfig extends BaseConfig {
  readonly provider: "funnel";
  readonly mode?: "http" | "tcp";
  readonly helper: ConnectorHelper;
  readonly hostname: string;
  readonly authKey: string;
  readonly stateDirectory: string;
  readonly port: 443 | 8443 | 10000;
}
export interface ZrokConfig extends BaseConfig {
  readonly provider: "zrok";
  readonly helper: ConnectorHelper;
  readonly mode: "public" | "reserved";
  /** A separately enabled private zrok environment; never the user's global home. */
  readonly environmentDirectory: string;
  readonly reservedToken?: string;
  readonly publicOrigin?: string;
}
export interface PangolinConfig extends BaseConfig {
  readonly provider: "pangolin";
  readonly mode: "http" | "tcp";
  readonly helper: ConnectorHelper;
  readonly endpoint: string;
  readonly siteId: string;
  readonly siteSecret: string;
  readonly publicOrigin: string;
}
export interface NetbirdConfig extends BaseConfig {
  readonly provider: "netbird";
  readonly helper: ConnectorHelper;
  readonly managementUrl: string;
  readonly setupKey: string;
  readonly stateDirectory: string;
  readonly mode: "http" | "tls" | "tcp";
  readonly publicOrigin: string;
  readonly resourceId: string;
  /** Peer-side userspace listener. This equals management targetPort, never the
   * public reverse-proxy listen_port returned by the management API. */
  readonly listenPort: number;
}
export interface DevTunnelsConfig extends BaseConfig {
  readonly provider: "dev-tunnels";
  readonly tunnelId: string;
  readonly clusterId: string;
  readonly hostAccessToken: string;
  readonly publicOrigin: string;
  /** The port reserved in the anonymous web-forwarding resource. */
  readonly port: number;
}
export type ConnectorConfig = NgrokConfig | PinggyConfig | LocaltunnelConfig | SshConfig | FrpConfig | RatholeConfig | BoreConfig | FunnelConfig | ZrokConfig | PangolinConfig | NetbirdConfig | DevTunnelsConfig;

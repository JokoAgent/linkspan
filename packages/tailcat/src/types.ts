import type { OperationOptions } from "@jokoagent/linkspan-core";
import type { PeerStream } from "@jokoagent/linkspan-core/stream";
import type { Identity, VerifiedChannel } from "@jokoagent/linkspan-noise";
export type { TailcatRuntime, TailcatIdentity } from "@jokoagent/linkspan-tailcat-runtime";

/** Contains a PSK. Exchange privately and keep in protected storage. */
export interface TailcatLocation { readonly address: string; readonly endpointId: string; readonly port: number }
export interface TailcatConnectOptions extends OperationOptions {
  address: string;
  expectedEndpointId: string;
  port: number;
  expectedPublicKey: string;
  identity?: Identity;
  /** Optional separately persisted backend client key for the server allowlist. */
  clientKey?: string;
  derpMapUrl?: string;
}
export interface TailcatListenOptions extends OperationOptions {
  identity: Identity;
  port?: number;
  /** Host-owned persistent backend key and PSK; absent means ephemeral. */
  serverKey?: string;
  presharedKey?: string;
  allowedClients: readonly string[];
  /** Explicit pairing-only admission for a privately delivered fresh PSK address. */
  allowPrivateAddressPairing?: boolean;
  derpMapUrl?: string;
  regionId?: number;
}
export interface TailcatRawListener extends TailcatLocation {
  accept(options?: OperationOptions): Promise<PeerStream | null>;
  close(): Promise<void>;
}
export interface TailcatListener extends TailcatLocation {
  accept(options?: OperationOptions): Promise<VerifiedChannel | null>;
  close(): Promise<void>;
}

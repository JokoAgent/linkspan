import type { OperationOptions } from "@jokoagent/linkspan-core";
import type { PeerStream } from "@jokoagent/linkspan-core/stream";
import type { Identity, VerifiedChannel } from "@jokoagent/linkspan-noise";

export interface IrohLocation { readonly ticket: string; readonly endpointId: string }
export interface IrohConnectOptions extends OperationOptions {
  ticket: string;
  /** Independently trusted backend endpoint id; the ticket is only a locator. */
  expectedEndpointId: string;
  /** The host's pinned application endpoint identity, independent of iroh. */
  expectedPublicKey: string;
  identity?: Identity;
  /** Local backend identity, required for a relay lease scoped to this client. */
  clientKey?: string;
  relayUrls?: readonly string[];
  relayToken?: string;
  relayTokenExpiresAt?: number;
}
export interface IrohIdentity { privateKey: string; publicKey: string }
export interface IrohListenOptions extends OperationOptions {
  identity: Identity;
  /** Optional host-owned 32-byte persistent iroh secret; never given to a relay. */
  secretKey?: Uint8Array;
  relayUrls?: readonly string[];
  /** A paid relay is used only when the host explicitly supplies its configuration. */
  relayToken?: string;
  relayTokenExpiresAt?: number;
  /** Publisher-only services1 secret; never include in an invitation/client profile. */
  servicesApiSecret?: string;
  servicesTokenTtlSeconds?: number;
}
export interface IrohRawListener extends IrohLocation {
  accept(options?: OperationOptions): Promise<PeerStream | null>;
  close(): Promise<void>;
}
export interface IrohRuntime {
  dispose?(): void;
  generateIdentity(): Promise<IrohIdentity>;
  connect(options: Pick<IrohConnectOptions, "ticket" | "expectedEndpointId" | "clientKey" | "relayUrls" | "relayToken" | "relayTokenExpiresAt"> & OperationOptions): Promise<PeerStream>;
  listen(options: Omit<IrohListenOptions, "identity">): Promise<IrohRawListener>;
}
export interface IrohListener extends IrohLocation {
  accept(options?: OperationOptions): Promise<VerifiedChannel | null>;
  close(): Promise<void>;
}

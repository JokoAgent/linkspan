import type { ByteChannel, OperationOptions } from "@jokoagent/linkspan-core";
import type { StreamCarrier } from "@jokoagent/linkspan-core/stream";
export type { StreamCarrier } from "@jokoagent/linkspan-core/stream";

export interface Identity {
  /** Host-owned protobuf-encoded Ed25519 private key. Never send to a connector. */
  privateKey: Uint8Array;
  /** A complete Ed25519 public key, obtained through an independently trusted path. */
  publicKey: string;
}

export interface VerifiedChannel extends ByteChannel {
  readonly remotePublicKey: string;
}

/** The common browser, React Native, and Node ws socket surface. */
export interface WebSocketLike {
  readonly readyState: number;
  /** Some native carriers do not expose queue depth; authenticated credit still bounds outstanding data. */
  readonly bufferedAmount?: number;
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: any) => void, options?: any): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
  /** Node ws can release a broken socket immediately. Not required in browsers. */
  terminate?(): void;
}

export interface ConnectWebSocketOptions extends OperationOptions {
  url: string;
  expectedPublicKey: string;
  /** Explicit host approval for a non-loopback WS carrier. Endpoint verification remains mandatory. */
  allowInsecureWebSocket?: boolean;
  identity?: Identity;
  createSocket?: (url: string) => WebSocketLike;
}

export interface AcceptWebSocketOptions extends OperationOptions {
  identity: Identity;
}

export interface ConnectStreamOptions extends OperationOptions {
  expectedPublicKey: string;
  identity?: Identity;
}

import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import { noise, pureJsCrypto } from "@libp2p/noise";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import type { NoiseComponents } from "@libp2p/noise";
import { NoiseChannel, MAX_MESSAGE_BYTES as MESSAGE_LIMIT, RECEIVE_WINDOW_BYTES as WINDOW_LIMIT } from "./channel.js";
import { createIdentity as generateIdentity, formatPublicKey, identityFromPrivateKey as restoreIdentity, importIdentity, parsePublicKey } from "./identity.js";
import { SocketStream, silentLogger } from "./socket.js";
import type { AcceptWebSocketOptions, ConnectWebSocketOptions, Identity, VerifiedChannel, WebSocketLike } from "./types.js";

export async function createIdentity(): Promise<Identity> {
  try { return await generateIdentity(); }
  catch (cause) { throw new LinkspanError("unavailable", "The secure endpoint identity runtime is unavailable", { cause }); }
}
export async function identityFromPrivateKey(privateKey: Uint8Array): Promise<Identity> { return restoreIdentity(privateKey); }
export const MAX_MESSAGE_BYTES = MESSAGE_LIMIT;
export const RECEIVE_WINDOW_BYTES = WINDOW_LIMIT;
export type { Identity, VerifiedChannel, WebSocketLike, ConnectWebSocketOptions, AcceptWebSocketOptions } from "./types.js";

const PROLOGUE = new TextEncoder().encode("linkspan/noise-websocket/1");
const HANDSHAKE_TIMEOUT_MS = 10_000;

function handshakeError(error: unknown) {
  if (error instanceof Error && error.name === "UnexpectedPeerError") {
    return new LinkspanError(error.message.includes("does not match expected") ? "identity_mismatch" : "authentication_failed", "The remote endpoint identity was not authenticated", { cause: error });
  }
  return asLinkspanError(error, "authentication_failed");
}

async function secure(socket: WebSocketLike, options: AcceptWebSocketOptions, outbound: boolean, expectedPublicKey?: string): Promise<VerifiedChannel> {
  const scope = createOperationScope({
    ...(options.signal ? { signal: options.signal } : {}),
    deadline: Math.min(options.deadline ?? Infinity, Date.now() + HANDSHAKE_TIMEOUT_MS),
  });
  const raw = new SocketStream(socket, outbound ? "outbound" : "inbound");
  const cancel = () => raw.abort(asLinkspanError(scope.signal.reason));
  scope.signal.addEventListener("abort", cancel, { once: true });
  try {
    scope.check();
    if (socket.readyState !== 1) {
      if (socket.readyState !== 0) throw new LinkspanError("closed", "The carrier is closed");
      let opened!: () => void;
      let failed!: () => void;
      const opening = new Promise<void>((resolve, reject) => {
        opened = resolve;
        failed = () => reject(new LinkspanError("transport_error", "The WebSocket carrier did not open"));
        socket.addEventListener("open", opened, { once: true });
        socket.addEventListener("error", failed, { once: true });
        socket.addEventListener("close", failed, { once: true });
      });
      try { await scope.wait(opening); }
      finally {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", failed);
      }
    }
    const imported = await scope.wait(importIdentity(options.identity));
    const peerId = peerIdFromPublicKey(imported.key.publicKey);
    // This narrow object is sufficient for handshake-only mode. No libp2p node,
    // network discovery, multiplexer, identity store, or host state is created.
    const components = {
      privateKey: imported.key, peerId, logger: silentLogger,
      upgrader: { getStreamMuxers: () => new Map() },
    } as unknown as NoiseComponents;
    const encrypter = noise({ crypto: pureJsCrypto, prologueBytes: PROLOGUE })(components);
    const remotePeer = expectedPublicKey ? peerIdFromPublicKey(parsePublicKey(expectedPublicKey)) : undefined;
    const handshakeOptions = { signal: scope.signal, skipStreamMuxerNegotiation: true, ...(remotePeer ? { remotePeer } : {}) };
    const result = await scope.wait(outbound ? encrypter.secureOutbound(raw, handshakeOptions) : encrypter.secureInbound(raw, handshakeOptions));
    const remoteKey = result.remotePeer.publicKey;
    if (!remoteKey) throw new LinkspanError("authentication_failed", "The authenticated endpoint did not provide its identity key");
    const remotePublicKey = formatPublicKey(remoteKey);
    if (expectedPublicKey !== undefined && remotePublicKey !== expectedPublicKey) {
      throw new LinkspanError("identity_mismatch", "The remote endpoint key did not match the trusted key");
    }
    scope.check();
    return new NoiseChannel(result.connection, remotePublicKey, options.signal);
  } catch (error) {
    const normalized = handshakeError(error);
    raw.abort(normalized);
    throw normalized;
  } finally {
    scope.signal.removeEventListener("abort", cancel);
    scope.dispose();
  }
}

export async function connectWebSocket(options: ConnectWebSocketOptions): Promise<VerifiedChannel> {
  // Validate the pin and cancellation before starting any carrier or key work.
  parsePublicKey(options.expectedPublicKey);
  const scope = createOperationScope(options);
  try {
    scope.check();
    let url: URL;
    try { url = new URL(options.url); }
    catch { throw new LinkspanError("invalid_argument", "A valid WebSocket URL is required"); }
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "wss:" && !(url.protocol === "ws:" && (loopback || options.allowInsecureWebSocket === true))) || url.username || url.password || url.hash || options.url.length > 2048) {
      throw new LinkspanError("invalid_argument", "Use WSS or a host-approved WS carrier without URL credentials or fragments");
    }
    const identity = options.identity ?? await scope.wait(createIdentity());
    scope.check();
    const createSocket = options.createSocket ?? ((address: string) => new WebSocket(address));
    const socket = createSocket(url.href);
    return await secure(socket, { identity, ...(options.signal ? { signal: options.signal } : {}), ...(options.deadline !== undefined ? { deadline: options.deadline } : {}) }, true, options.expectedPublicKey);
  } catch (error) { throw asLinkspanError(error); }
  finally { scope.dispose(); }
}

export async function acceptWebSocket(socket: WebSocketLike, options: AcceptWebSocketOptions): Promise<VerifiedChannel> {
  return secure(socket, options, false);
}

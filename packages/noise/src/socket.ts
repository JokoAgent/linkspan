import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import { AbstractMessageStream } from "@libp2p/utils";
import type { ComponentLogger, Logger } from "@libp2p/interface";
import type { Uint8ArrayList } from "uint8arraylist";
import type { WebSocketLike } from "./types.js";

// Never permit upstream DEBUG/DUMP_SESSION_KEYS to publish identity/session keys.
const noop = Object.assign(() => {}, { enabled: false }) as unknown as Logger;
noop.error = noop;
noop.trace = noop;
noop.newScope = () => noop;
export const silentLogger: ComponentLogger = { forComponent: () => noop };

const MAX_SOCKET_MESSAGE_BYTES = 128 * 1024;
const MAX_SOCKET_BUFFER_BYTES = 256 * 1024;
const SOCKET_LOW_WATER_BYTES = 32 * 1024;

/** Framing and AEAD remain entirely in the upstream Noise implementation. */
export class SocketStream extends AbstractMessageStream {
  readonly socket: WebSocketLike;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly socketClosed: Promise<void>;
  private resolveSocketClosed!: () => void;
  private detached = false;

  constructor(socket: WebSocketLike, direction: "inbound" | "outbound") {
    super({
      log: noop,
      direction,
      maxReadBufferLength: MAX_SOCKET_BUFFER_BYTES,
      maxWriteBufferLength: MAX_SOCKET_BUFFER_BYTES,
      maxMessageSize: 32 * 1024,
    });
    this.socket = socket;
    this.socketClosed = new Promise((resolve) => { this.resolveSocketClosed = resolve; });
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", this.onMessage);
    socket.addEventListener("error", this.onError);
    socket.addEventListener("close", this.onClose);
  }

  private readonly onMessage = (event: { data: unknown }) => {
    try {
      const data = event.data;
      let bytes: Uint8Array;
      if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      else throw new LinkspanError("protocol_error", "The carrier must deliver binary messages");
      if (bytes.byteLength > MAX_SOCKET_MESSAGE_BYTES) {
        throw new LinkspanError("resource_exhausted", "The carrier message limit was exceeded");
      }
      this.onData(bytes);
    } catch (error) { this.abort(asLinkspanError(error)); }
  };

  private readonly onError = () => this.abort(new LinkspanError("transport_error", "The WebSocket carrier failed"));
  private readonly onClose = () => {
    this.detach();
    this.onTransportClosed();
    this.resolveSocketClosed();
  };

  private detach() {
    if (this.detached) return;
    this.detached = true;
    if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
    this.socket.removeEventListener("message", this.onMessage);
    this.socket.removeEventListener("error", this.onError);
    this.socket.removeEventListener("close", this.onClose);
  }

  private pollDrain() {
    if (this.drainTimer !== undefined || this.detached) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = undefined;
      if (this.socket.readyState !== 1) return;
      if ((this.socket.bufferedAmount ?? 0) <= SOCKET_LOW_WATER_BYTES) this.safeDispatchEvent("drain");
      else this.pollDrain();
    }, 4);
  }

  sendData(data: Uint8ArrayList) {
    if (this.socket.readyState !== 1) throw new LinkspanError("closed", "The WebSocket carrier is closed");
    // RN's WebSocket declares bufferedAmount but leaves it undefined. Waiting
    // for an unobservable queue depth would deadlock the Noise handshake. Once
    // authenticated, the channel credit window bounds data awaiting peer reads,
    // even when the carrier cannot report its own queued bytes.
    if ((this.socket.bufferedAmount ?? 0) >= MAX_SOCKET_BUFFER_BYTES) {
      this.pollDrain();
      return { sentBytes: 0, canSendMore: false };
    }
    this.socket.send(data.subarray());
    const canSendMore = (this.socket.bufferedAmount ?? 0) < MAX_SOCKET_BUFFER_BYTES;
    if (!canSendMore) this.pollDrain();
    return { sentBytes: data.byteLength, canSendMore };
  }

  // Browser WebSocket has no receive pause primitive. Authenticated credit flow
  // control above Noise bounds compliant peers; buffer limits reject offenders.
  sendPause() {}
  sendResume() {}

  sendReset(_error: Error) {
    if (this.drainTimer !== undefined) clearTimeout(this.drainTimer);
    try {
      if (this.socket.terminate) this.socket.terminate();
      // Script-facing WebSocket.close only permits 1000 or application codes
      // 3000..4999. Reserved protocol codes throw and would leave a browser
      // carrier alive after local authorization was already revoked.
      else if (this.socket.readyState < 2) this.socket.close(4000, "Connection terminated");
    } catch {}
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeSocket();
    return this.closePromise;
  }

  private async closeSocket() {
    if (this.socket.readyState === 3) return;
    const scope = createOperationScope({ deadline: Date.now() + 5_000 });
    try {
      await this.onDrain({ signal: scope.signal });
      this.writeStatus = "closing";
      this.socket.close(1000, "");
      await scope.wait(this.socketClosed);
    } catch (error) {
      this.abort(asLinkspanError(error));
      throw error;
    } finally { scope.dispose(); }
  }
}

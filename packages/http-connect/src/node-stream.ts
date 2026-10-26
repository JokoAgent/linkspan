import { Socket } from "node:net";
import { LinkspanError, asLinkspanError, createOperationScope, type OperationOptions } from "@jokoagent/linkspan-core";
import type { StreamCarrier } from "@jokoagent/linkspan-core/stream";

export const NODE_STREAM_LIMITS = Object.freeze({ maximumChunkBytes: 128 * 1024, maximumBufferBytes: 256 * 1024, closeTimeoutMs: 10_000 });

export interface NodeStreamOptions extends OperationOptions {
  /** Bytes already removed by an HTTP parser, before its socket was handed off. */
  readonly initialData?: Uint8Array;
}

/** Transfers exclusive ownership of one already selected socket. It does not
 * authenticate its peer, select a target, or enable any forwarding listener. */
export function createNodeStreamCarrier(socket: Socket, options: NodeStreamOptions = {}): StreamCarrier {
  if (!(socket instanceof Socket)) throw new LinkspanError("invalid_argument", "A selected Node socket is required.");
  if (socket.readableHighWaterMark > NODE_STREAM_LIMITS.maximumBufferBytes
    || options.initialData !== undefined && (!(options.initialData instanceof Uint8Array)
      || options.initialData.byteLength > NODE_STREAM_LIMITS.maximumChunkBytes)) {
    socket.destroy();
    throw new LinkspanError("invalid_argument", "The selected socket or initial carrier bytes exceed their bounds.");
  }
  return new NodeStreamCarrier(socket, options);
}

class NodeStreamCarrier implements StreamCarrier {
  readonly #scope;
  readonly #closed: Promise<void>;
  #resolveClosed!: () => void;
  #initial: Uint8Array | undefined;
  #reading = false;
  #write: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #readEnded = false;
  #socketClosed = false;
  #error: LinkspanError | undefined;
  #wake: (() => void) | undefined;

  constructor(readonly socket: Socket, readonly options: NodeStreamOptions) {
    this.#scope = createOperationScope(options);
    this.#initial = options.initialData?.slice();
    this.#readEnded = socket.readableEnded;
    this.#closed = new Promise(resolve => { this.#resolveClosed = resolve; });
    socket.pause();
    socket.setNoDelay(true);
    socket.on("readable", this.#readable);
    socket.on("end", this.#end);
    socket.on("error", this.#failed);
    socket.once("close", this.#close);
    this.#scope.signal.addEventListener("abort", this.#cancel, { once: true });
    if (socket.destroyed) this.#close();
    if (this.#scope.signal.aborted) this.#cancel();
  }

  readonly #readable = (): void => {
    if (this.socket.readableLength > NODE_STREAM_LIMITS.maximumBufferBytes) {
      this.abort(new LinkspanError("resource_exhausted", "The selected byte carrier receive buffer is full."));
    }
    this.#notify();
  };
  readonly #end = (): void => { this.#readEnded = true; this.#notify(); };
  readonly #failed = (error: Error): void => {
    this.#error ??= asLinkspanError(error, "transport_error");
    this.#notify();
  };
  readonly #cancel = (): void => this.abort(this.#scope.signal.reason);
  readonly #close = (): void => {
    if (this.#socketClosed) return;
    this.#socketClosed = true;
    this.#readEnded ||= this.socket.readableEnded;
    if (!this.#readEnded) this.#error ??= new LinkspanError("transport_error", "The selected byte carrier ended without an orderly EOF.");
    this.socket.removeListener("readable", this.#readable);
    this.socket.removeListener("end", this.#end);
    // Keep the owned socket's error sink through any final native callbacks.
    this.#scope.signal.removeEventListener("abort", this.#cancel);
    this.#scope.dispose();
    this.#resolveClosed();
    this.#notify();
  };
  #notify(): void { const wake = this.#wake; this.#wake = undefined; wake?.(); }

  async read(): Promise<Uint8Array | null> {
    if (this.#reading) throw new LinkspanError("invalid_argument", "Only one carrier read may be pending.");
    this.#reading = true;
    try {
      for (;;) {
        if (this.#error !== undefined) throw this.#error;
        if (this.#initial !== undefined) { const bytes = this.#initial; this.#initial = undefined; if (bytes.byteLength > 0) return bytes; }
        const length = this.socket.readableLength;
        if (length > NODE_STREAM_LIMITS.maximumBufferBytes) {
          this.abort(new LinkspanError("resource_exhausted", "The selected byte carrier receive buffer is full."));
          throw this.#error;
        }
        if (length > 0) {
          const bytes = this.socket.read(Math.min(length, NODE_STREAM_LIMITS.maximumChunkBytes)) as Buffer | null;
          if (bytes !== null) return new Uint8Array(bytes);
        }
        if (this.#readEnded) return null;
        this.#scope.check();
        await this.#scope.wait(new Promise<void>(resolve => {
          this.#wake = resolve;
          this.socket.read(0);
          if (this.socket.readableLength > 0 || this.#readEnded || this.#error !== undefined) this.#notify();
        }));
      }
    } finally { this.#reading = false; this.#wake = undefined; }
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.#error !== undefined) throw this.#error;
    if (this.#socketClosed || this.#closing !== undefined || this.socket.writableEnded) throw new LinkspanError("closed", "The selected byte carrier is closing.");
    if (this.#write !== undefined) throw new LinkspanError("resource_exhausted", "Only one carrier write may be pending.");
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > NODE_STREAM_LIMITS.maximumChunkBytes) throw new LinkspanError("invalid_argument", "The carrier write exceeds its byte limit.");
    this.#scope.check();
    const pending = new Promise<void>((resolve, reject) => {
      this.socket.write(Buffer.from(bytes), error => { if (error) reject(error); else resolve(); });
    });
    this.#write = pending;
    try { await this.#scope.wait(pending); }
    catch (error) { this.abort(error); throw this.#error; }
    finally { if (this.#write === pending) this.#write = undefined; }
  }

  close(): Promise<void> { return this.#closing ??= this.#gracefulClose(); }
  async #gracefulClose(): Promise<void> {
    const scope = createOperationScope({ signal: this.#scope.signal,
      deadline: Math.min(this.options.deadline ?? Infinity, Date.now() + NODE_STREAM_LIMITS.closeTimeoutMs) });
    try {
      scope.check();
      if (this.#write !== undefined) await scope.wait(this.#write);
      if (this.#error !== undefined) throw this.#error;
      if (!this.#socketClosed && !this.socket.writableEnded) this.socket.end();
      await scope.wait(this.#closed);
      if (this.#error !== undefined) throw this.#error;
    } catch (error) { this.abort(error); throw this.#error; }
    finally { scope.dispose(); }
  }

  abort(reason?: unknown): void {
    this.#error ??= reason === undefined ? new LinkspanError("cancelled", "The selected byte carrier was cancelled.")
      : asLinkspanError(reason, "transport_error");
    this.#initial = undefined;
    this.socket.destroy();
    this.#notify();
  }
}

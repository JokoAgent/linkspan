import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import type { CloseResult, OperationOptions, OperationScope } from "@jokoagent/linkspan-core";
import type { MessageStream, StreamMessageEvent, StreamCloseEvent } from "@libp2p/interface";
import type { VerifiedChannel } from "./types.js";

export const MAX_MESSAGE_BYTES = 64 * 1024;
export const RECEIVE_WINDOW_BYTES = 256 * 1024;
const HEADER_BYTES = 5;
const MIN_CREDIT_CHARGE = 256;
const MAX_QUEUED_MESSAGES = RECEIVE_WINDOW_BYTES / MIN_CREDIT_CHARGE;
const DATA = 1;
const CREDIT = 2;
const CLOSE = 3;

function cost(bytes: number) { return Math.max(MIN_CREDIT_CHARGE, bytes + HEADER_BYTES); }
function record(type: number, value: number, payload?: Uint8Array) {
  const bytes = new Uint8Array(HEADER_BYTES + (payload?.byteLength ?? 0));
  bytes[0] = type;
  new DataView(bytes.buffer).setUint32(1, value, false);
  if (payload) bytes.set(payload, HEADER_BYTES);
  return bytes;
}

interface SendRequest {
  payload: Uint8Array;
  charge: number;
  scope: OperationScope;
  active: boolean;
  sent: boolean;
  settled: boolean;
  resolve(): void;
  reject(error: unknown): void;
  onAbort(): void;
}

/** Only authenticated transport bytes enter the small non-cryptographic framing layer. */
export class NoiseChannel implements VerifiedChannel {
  readonly remotePublicKey: string;
  readonly closed: Promise<CloseResult>;
  private resolveClosed!: (result: CloseResult) => void;
  private readonly stream: MessageStream;
  private readonly ownerSignal?: AbortSignal;
  private readonly outgoing: SendRequest[] = [];
  private readonly incoming: { bytes: Uint8Array; charge: number }[] = [];
  private readonly changed = new Set<() => void>();
  private pendingBytes = 0;
  private sending = false;
  private receiving = false;
  private remoteCredit = 0;
  private receiveCredit = RECEIVE_WINDOW_BYTES;
  private creditToSend = RECEIVE_WINDOW_BYTES;
  private flushingCredits = false;
  private parser = new Uint8Array(0);
  private localClosing = false;
  private remoteClosing = false;
  private terminated = false;
  private failure?: LinkspanError;
  private closePromise?: Promise<void>;

  constructor(stream: MessageStream, remotePublicKey: string, ownerSignal?: AbortSignal) {
    this.stream = stream;
    this.remotePublicKey = remotePublicKey;
    this.ownerSignal = ownerSignal;
    this.closed = new Promise((resolve) => { this.resolveClosed = resolve; });
    stream.maxWriteBufferLength = RECEIVE_WINDOW_BYTES;
    stream.addEventListener("message", this.onMessage);
    stream.addEventListener("close", this.onStreamClose);
    ownerSignal?.addEventListener("abort", this.onOwnerAbort, { once: true });
    if (ownerSignal?.aborted) this.onOwnerAbort();
    else this.flushCredits();
  }

  private readonly onOwnerAbort = () => this.abort(new LinkspanError("cancelled", "The connection owner cancelled the channel"));
  private notify() { for (const wake of Array.from(this.changed)) wake(); }
  private waitForChange(scope: OperationScope): Promise<void> {
    let wake!: () => void;
    const change = new Promise<void>((resolve) => { wake = resolve; this.changed.add(wake); });
    return scope.wait(change).finally(() => { this.changed.delete(wake); });
  }

  private readonly onMessage = (event: StreamMessageEvent) => {
    try {
      const chunk = event.data.subarray();
      if (this.remoteClosing) throw new LinkspanError("protocol_error", "Data followed an authenticated close");
      if (this.parser.byteLength + chunk.byteLength > 2 * (MAX_MESSAGE_BYTES + HEADER_BYTES)) {
        throw new LinkspanError("resource_exhausted", "The authenticated parser buffer limit was exceeded");
      }
      const bytes = new Uint8Array(this.parser.byteLength + chunk.byteLength);
      bytes.set(this.parser);
      bytes.set(chunk, this.parser.byteLength);
      let offset = 0;
      while (bytes.byteLength - offset >= HEADER_BYTES) {
        const type = bytes[offset];
        const value = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
        if (type === DATA && value > MAX_MESSAGE_BYTES) throw new LinkspanError("protocol_error", "The channel message limit was exceeded");
        if (type !== DATA && type !== CREDIT && type !== CLOSE) throw new LinkspanError("protocol_error", "Unknown authenticated channel record");
        const length = HEADER_BYTES + (type === DATA ? value : 0);
        if (bytes.byteLength - offset < length) break;
        if (type === DATA) {
          const charge = cost(value);
          if (this.receiveCredit < charge || this.incoming.length >= MAX_QUEUED_MESSAGES) {
            throw new LinkspanError("resource_exhausted", "The peer exceeded its receive credit");
          }
          this.receiveCredit -= charge;
          this.incoming.push({ bytes: bytes.slice(offset + HEADER_BYTES, offset + length), charge });
        } else if (type === CREDIT) {
          if (value === 0 || this.remoteCredit + value > RECEIVE_WINDOW_BYTES) throw new LinkspanError("protocol_error", "Invalid channel receive credit");
          this.remoteCredit += value;
        } else {
          if (value !== 0 || offset + length !== bytes.byteLength) throw new LinkspanError("protocol_error", "Invalid authenticated close");
          this.remoteClosing = true;
          // Send an authenticated close acknowledgement before releasing the carrier.
          void this.close().catch(() => {});
        }
        offset += length;
      }
      this.parser = bytes.slice(offset);
      this.notify();
    } catch (error) { this.abort(asLinkspanError(error, "authentication_failed")); }
  };

  private readonly onStreamClose = (event: StreamCloseEvent) => {
    if (this.terminated) return;
    if (event.error) this.finish(asLinkspanError(event.error, "authentication_failed"));
    else if (this.parser.byteLength !== 0 || !this.remoteClosing) {
      this.finish(new LinkspanError("transport_error", "The carrier closed without an authenticated end of channel"));
    } else this.finish();
  };

  private finish(error?: LinkspanError) {
    if (this.terminated) return;
    this.terminated = true;
    this.failure = error;
    this.ownerSignal?.removeEventListener("abort", this.onOwnerAbort);
    this.stream.removeEventListener("message", this.onMessage);
    this.stream.removeEventListener("close", this.onStreamClose);
    if (error) { this.incoming.length = 0; this.parser = new Uint8Array(0); }
    this.notify();
    for (const request of [...this.outgoing]) this.settle(request, error ?? new LinkspanError("closed", "The channel is closed"));
    this.resolveClosed(error ? { error } : {});
  }

  private checkOpen() {
    if (this.failure) throw this.failure;
    if (this.terminated || this.localClosing || this.remoteClosing) throw new LinkspanError("closed", "The channel is closed");
  }

  async send(data: Uint8Array, options: OperationOptions = {}): Promise<void> {
    if (!(data instanceof Uint8Array) || data.byteLength > MAX_MESSAGE_BYTES) {
      throw new LinkspanError("invalid_argument", `Channel messages may contain at most ${MAX_MESSAGE_BYTES} bytes`, { outcome: "not_sent" });
    }
    const scope = createOperationScope(options);
    try {
      scope.check();
      this.checkOpen();
      const charge = cost(data.byteLength);
      if (this.pendingBytes + charge > RECEIVE_WINDOW_BYTES || this.outgoing.length >= MAX_QUEUED_MESSAGES) {
        throw new LinkspanError("resource_exhausted", "The bounded send queue is full", { outcome: "not_sent" });
      }
      this.pendingBytes += charge;
      await new Promise<void>((resolve, reject) => {
        const request: SendRequest = {
          payload: data.slice(), charge, scope, active: false, sent: false, settled: false,
          resolve, reject,
          onAbort: () => {
            if (!request.active) this.settle(request, asLinkspanError(scope.signal.reason));
          },
        };
        scope.signal.addEventListener("abort", request.onAbort, { once: true });
        this.outgoing.push(request);
        void this.drainSends();
      });
    } finally { scope.dispose(); }
  }

  private settle(request: SendRequest, error?: unknown) {
    if (request.settled) return;
    request.settled = true;
    const index = this.outgoing.indexOf(request);
    if (index >= 0) this.outgoing.splice(index, 1);
    this.pendingBytes -= request.charge;
    request.scope.signal.removeEventListener("abort", request.onAbort);
    if (error) {
      const normalized = asLinkspanError(error);
      request.reject(new LinkspanError(normalized.code, normalized.message, { cause: normalized, outcome: request.sent ? "unknown" : "not_sent" }));
    } else request.resolve();
  }

  private async drainSends() {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.outgoing.length > 0) {
        const request = this.outgoing[0]!;
        request.active = true;
        try {
          request.scope.check();
          this.checkOpen();
          while (this.remoteCredit < request.charge) {
            await this.waitForChange(request.scope);
            this.checkOpen();
          }
          await this.writable(request.scope);
          request.scope.check();
          this.checkOpen();
          this.remoteCredit -= request.charge;
          request.sent = true;
          const available = this.stream.send(record(DATA, request.payload.byteLength, request.payload));
          if (!available) await this.stream.onDrain({ signal: request.scope.signal });
          this.settle(request);
        } catch (error) { this.settle(request, error); }
      }
    } finally { this.sending = false; }
  }

  private async writable(scope: OperationScope) {
    if (this.stream.writableNeedsDrain) await this.stream.onDrain({ signal: scope.signal });
    scope.check();
    if (this.failure) throw this.failure;
  }

  private flushCredits() {
    if (this.flushingCredits || this.localClosing || this.terminated) return;
    this.flushingCredits = true;
    queueMicrotask(() => {
      void (async () => {
        const scope = createOperationScope({ deadline: Date.now() + 30_000 });
        try {
          while (this.creditToSend > 0 && !this.localClosing && !this.terminated) {
            await this.writable(scope);
            if (this.localClosing || this.terminated) break;
            const grant = this.creditToSend;
            this.creditToSend = 0;
            if (!this.stream.send(record(CREDIT, grant))) await this.stream.onDrain({ signal: scope.signal });
          }
        } catch (error) { this.abort(error); }
        finally { scope.dispose(); this.flushingCredits = false; }
      })();
    });
  }

  async receive(options: OperationOptions = {}): Promise<Uint8Array | null> {
    if (this.receiving) throw new LinkspanError("invalid_argument", "Only one receive operation may be pending");
    const scope = createOperationScope(options);
    this.receiving = true;
    try {
      scope.check();
      while (!this.failure && this.incoming.length === 0 && !this.remoteClosing && !this.terminated) await this.waitForChange(scope);
      scope.check();
      if (this.failure) throw this.failure;
      const message = this.incoming.shift();
      if (!message) return null;
      this.receiveCredit += message.charge;
      this.creditToSend += message.charge;
      this.flushCredits();
      return message.bytes;
    } finally { scope.dispose(); this.receiving = false; }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeChannel();
    return this.closePromise;
  }

  private async closeChannel() {
    if (this.terminated) return;
    this.localClosing = true;
    this.notify();
    const scope = createOperationScope({ deadline: Date.now() + 5_000 });
    try {
      await this.writable(scope);
      if (!this.stream.send(record(CLOSE, 0))) await this.stream.onDrain({ signal: scope.signal });
      // Wait for the authenticated acknowledgement. A relay cannot forge EOF by
      // merely issuing a normal WebSocket close or truncating a response.
      while (!this.remoteClosing && !this.terminated) await this.waitForChange(scope);
      if (this.failure) throw this.failure;
      await scope.wait(this.stream.close({ signal: scope.signal }));
      const result = await scope.wait(this.closed);
      if (result.error) throw result.error;
    } catch (error) { this.abort(error); throw error; }
    finally { scope.dispose(); }
  }

  abort(reason?: unknown) {
    if (this.terminated) return;
    const error = reason === undefined
      ? new LinkspanError("cancelled", "The channel was aborted")
      : asLinkspanError(reason);
    this.finish(error);
    this.stream.abort(error);
  }
}

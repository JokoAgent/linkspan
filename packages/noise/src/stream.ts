import { LinkspanError, asLinkspanError } from "@jokoagent/linkspan-core";
import type { StreamCarrier, WebSocketLike } from "./types.js";

/** Bounded adapter only; framing, handshake and encryption remain upstream. */
export class StreamSocket implements WebSocketLike {
  readyState = 1;
  bufferedAmount = 0;
  binaryType = "arraybuffer";
  private readonly listeners = new Map<string, Set<(event: any) => void>>();
  private writes: Promise<void> = Promise.resolve();
  private ended = false;

  constructor(private readonly carrier: StreamCarrier) {
    queueMicrotask(() => { void this.read(); });
  }

  addEventListener(type: string, listener: (event: any) => void) {
    let entries = this.listeners.get(type);
    if (!entries) { entries = new Set(); this.listeners.set(type, entries); }
    entries.add(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  private emit(type: string, event: unknown = {}) {
    for (const listener of [...this.listeners.get(type) ?? []]) listener(event);
  }
  private isClosing(){return this.readyState>=2;}

  private finish(error?: unknown) {
    if (this.ended) return;
    this.ended = true;
    this.readyState = 3;
    if (error !== undefined) this.emit("error", { error: asLinkspanError(error) });
    this.emit("close");
    this.listeners.clear();
  }

  private async read() {
    try {
      while (this.readyState === 1) {
        const bytes = await this.carrier.read();
        if (bytes === null) {
          if(this.isClosing())return;
          this.carrier.abort(); this.finish(); return;
        }
        if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 128 * 1024) {
          throw new LinkspanError("protocol_error", "Invalid ordered carrier bytes");
        }
        if (this.readyState === 1) this.emit("message", { data: bytes });
      }
    } catch (error) {
      // SDK connection close can reject an outstanding read. Once Noise has
      // authenticated both close records, let the explicit carrier close own
      // teardown and emit its completion instead of racing it with read errors.
      if(this.isClosing())return;
      this.carrier.abort(error);
      this.finish(error);
    }
  }

  send(data: Uint8Array) {
    if (this.readyState !== 1) throw new LinkspanError("closed", "The ordered carrier is closed");
    if (this.bufferedAmount + data.byteLength > 512 * 1024) {
      throw new LinkspanError("resource_exhausted", "The ordered carrier send queue is full");
    }
    const copy = data.slice();
    this.bufferedAmount += copy.byteLength;
    this.writes = this.writes.then(async () => {
      if (this.readyState === 3) throw new LinkspanError("closed", "The ordered carrier is closed");
      await this.carrier.write(copy);
    }).catch(error => {
      this.carrier.abort(error);
      this.finish(error);
    }).finally(() => { this.bufferedAmount -= copy.byteLength; });
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    void this.writes.then(() => this.carrier.close()).then(() => this.finish(), error => {
      this.carrier.abort(error);
      this.finish(error);
    });
  }

  terminate() {
    this.carrier.abort(new LinkspanError("cancelled", "The ordered carrier was terminated"));
    this.finish();
  }
}

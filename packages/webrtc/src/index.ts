import { createOperationScope, LinkspanError, asLinkspanError, type ByteChannel, type CloseResult, type OperationOptions } from "@jokoagent/linkspan-core";

export interface WebRtcChannelOptions extends OperationOptions {
  readonly peerConnection: RTCPeerConnection;
  readonly dataChannel: RTCDataChannel;
  /** SHA-256 of the peer's DER certificate, supplied by authenticated signaling. */
  readonly expectedFingerprint: string;
  readonly maximumMessageBytes?: number;
  readonly maximumBufferedBytes?: number;
  readonly maximumReceiveBytes?: number;
  /** False when the host also uses this connection for media or other channels. */
  readonly ownsPeerConnection?: boolean;
}

export const WEBRTC_LIMITS = Object.freeze({ maximumMessageBytes: 65535, maximumBufferedBytes: 524288,
  maximumReceiveBytes: 8388608, signalingRequired: true, encryption: "platform-dtls-sctp", reliableOrderedOnly: true });

/**
 * Signaling and media authority belong to the host. The platform performs the
 * DTLS handshake; compare the actual accepted certificate before exposing bytes.
 */
export async function openWebRtcChannel(options: WebRtcChannelOptions): Promise<ByteChannel & { readonly remoteFingerprint: string }> {
  const fingerprint = normalizeFingerprint(options.expectedFingerprint);
  const { dataChannel: data, peerConnection: peer } = options;
  if (!data.ordered || data.maxPacketLifeTime !== null || data.maxRetransmits !== null || !peer.sctp
    || !["connecting", "open"].includes(data.readyState)) throw invalid();
  const scope = createOperationScope({ ...options, deadline: options.deadline ?? Date.now() + 10000 });
  const channel = new RtcByteChannel(options, fingerprint);
  try {
    await scope.wait(channel.ready);
    scope.check();
    if (peer.sctp.transport.state !== "connected") throw new LinkspanError("authentication_failed", "The WebRTC DTLS handshake is not established.");
    const certificates = peer.sctp.transport.getRemoteCertificates();
    if (certificates.length < 1 || certificates[0]!.byteLength > 65536) throw new LinkspanError("authentication_failed", "The WebRTC peer certificate is unavailable.");
    const digest = new Uint8Array(await scope.wait(globalThis.crypto.subtle.digest("SHA-256", certificates[0]!)));
    const actual = [...digest].map(value => value.toString(16).padStart(2, "0")).join(":").toUpperCase();
    if (actual !== fingerprint) throw new LinkspanError("identity_mismatch", "The WebRTC certificate differs from the trusted signaling identity.");
    scope.check();
    return channel;
  } catch (error) { channel.abort(error); throw asLinkspanError(error); }
  finally { scope.dispose(); }
}

function invalid(): LinkspanError { return new LinkspanError("invalid_argument", "WebRTC requires a reliable ordered channel and a trusted SHA-256 certificate fingerprint."); }
function normalizeFingerprint(value: string): string {
  if (typeof value !== "string") throw invalid();
  const normalized = value.replace(/^sha-256\s+/iu, "").toUpperCase();
  if (!/^(?:[A-F0-9]{2}:){31}[A-F0-9]{2}$/u.test(normalized)) throw invalid();
  return normalized;
}

class RtcByteChannel implements ByteChannel {
  readonly closed: Promise<CloseResult>;
  readonly ready: Promise<void>;
  readonly remoteFingerprint: string;
  readonly #shutdown = new AbortController();
  readonly #chunks: Uint8Array[] = [];
  readonly #maximumMessage: number;
  readonly #maximumBuffered: number;
  readonly #maximumReceive: number;
  #receivedBytes = 0;
  #sending = false;
  #receiving = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;
  #ended = false;
  #error: LinkspanError | undefined;
  #wake: (() => void) | undefined;
  #resolveClosed!: (result: CloseResult) => void;
  #resolveReady!: () => void;
  #rejectReady!: (error: unknown) => void;
  constructor(readonly options: WebRtcChannelOptions, fingerprint: string) {
    this.remoteFingerprint = fingerprint;
    this.#maximumMessage = options.maximumMessageBytes ?? WEBRTC_LIMITS.maximumMessageBytes;
    this.#maximumBuffered = options.maximumBufferedBytes ?? WEBRTC_LIMITS.maximumBufferedBytes;
    this.#maximumReceive = options.maximumReceiveBytes ?? WEBRTC_LIMITS.maximumReceiveBytes;
    if (![this.#maximumMessage, this.#maximumBuffered, this.#maximumReceive].every(value => Number.isSafeInteger(value) && value > 0)
      || this.#maximumMessage > WEBRTC_LIMITS.maximumMessageBytes || this.#maximumBuffered < this.#maximumMessage
      || this.#maximumReceive < this.#maximumMessage || this.#maximumReceive > 64 * 1024 * 1024) throw invalid();
    this.closed = new Promise(resolve => { this.#resolveClosed = resolve; });
    this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    void this.ready.catch(() => undefined);
    const data = options.dataChannel;
    data.binaryType = "arraybuffer";
    data.bufferedAmountLowThreshold = Math.floor(this.#maximumBuffered / 2);
    data.addEventListener("open", this.#opened);
    data.addEventListener("message", this.#message);
    data.addEventListener("close", this.#closed);
    data.addEventListener("error", this.#failed);
    options.signal?.addEventListener("abort", this.#cancelled, { once: true });
    if (options.signal?.aborted) this.#cancelled();
    else if (data.readyState === "open") this.#opened();
  }
  readonly #opened = (): void => { this.#resolveReady(); };
  readonly #cancelled = (): void => { this.abort(new LinkspanError("cancelled", "The WebRTC connection was cancelled.")); };
  readonly #failed = (): void => { this.abort(new LinkspanError("transport_error", "The WebRTC data channel failed.")); };
  readonly #closed = (): void => { this.#finish(); };
  readonly #message = (event: MessageEvent): void => {
    if (this.#ended) return;
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > this.#maximumMessage
      || this.#receivedBytes + event.data.byteLength > this.#maximumReceive || this.#chunks.length >= 1024) {
      this.abort(new LinkspanError("resource_exhausted", "The WebRTC receive bounds were exceeded.")); return;
    }
    const bytes = new Uint8Array(event.data).slice();
    this.#chunks.push(bytes); this.#receivedBytes += bytes.byteLength; this.#wake?.();
  };
  #finish(error?: LinkspanError): void {
    if (this.#ended) return;
    this.#ended = true; this.#error = error;
    this.#shutdown.abort(error ?? new LinkspanError("closed", "The WebRTC channel closed."));
    this.#rejectReady(error ?? new LinkspanError("closed", "The WebRTC channel closed before opening."));
    const data = this.options.dataChannel;
    data.removeEventListener("open", this.#opened); data.removeEventListener("message", this.#message);
    data.removeEventListener("close", this.#closed); data.removeEventListener("error", this.#failed);
    this.options.signal?.removeEventListener("abort", this.#cancelled);
    if (error) { this.#chunks.length = 0; this.#receivedBytes = 0; }
    this.#wake?.(); this.#resolveClosed(error === undefined ? {} : { error });
  }
  abort(reason?: unknown): void {
    this.#finish(asLinkspanError(reason));
    this.options.dataChannel.close(); if (this.options.ownsPeerConnection) this.options.peerConnection.close();
  }
  close(): Promise<void> {
    this.#closePromise ??= this.#gracefulClose();
    return this.#closePromise;
  }
  async #gracefulClose(): Promise<void> {
    this.#closing = true;
    const data = this.options.dataChannel;
    const scope = createOperationScope({ ...(this.options.signal === undefined ? {} : { signal: this.options.signal }), deadline: Date.now() + 10000 });
    try {
      // Closing the peer immediately after enqueueing the last record can
      // discard SCTP bytes. Drain, then let the stream reset finish first.
      data.bufferedAmountLowThreshold = 0;
      while (!this.#ended && data.bufferedAmount > 0) {
        let wake!: () => void;
        const pending = new Promise<void>(resolve => { wake = resolve; });
        data.addEventListener("bufferedamountlow", wake, { once: true });
        data.addEventListener("close", wake, { once: true });
        try { await scope.wait(pending); }
        finally { data.removeEventListener("bufferedamountlow", wake); data.removeEventListener("close", wake); }
      }
      if (this.#error !== undefined) throw this.#error;
      if (!this.#ended) {
        let closed!: () => void;
        const pending = new Promise<void>(resolve => { closed = resolve; });
        data.addEventListener("close", closed, { once: true });
        try { data.close(); await scope.wait(pending); }
        finally { data.removeEventListener("close", closed); }
      }
      this.#finish();
    } catch (error) { this.abort(error); throw asLinkspanError(error); }
    finally {
      scope.dispose();
      if (this.options.ownsPeerConnection) await this.options.peerConnection.close();
    }
  }
  async send(bytes: Uint8Array, options: OperationOptions = {}): Promise<void> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > this.#maximumMessage) throw new LinkspanError("invalid_argument", "The WebRTC message exceeds the configured bound.");
    if (this.#sending) throw new LinkspanError("protocol_error", "Only one WebRTC send may be pending.");
    if (this.#ended || this.#closing) throw this.#error ?? new LinkspanError("closed", "The WebRTC channel is closed.");
    this.#sending = true;
    const scope = createOperationScope({ ...options, signal: options.signal === undefined ? this.#shutdown.signal : AbortSignal.any([options.signal, this.#shutdown.signal]) });
    try {
      scope.check();
      const data = this.options.dataChannel;
      while (data.bufferedAmount + bytes.byteLength > this.#maximumBuffered) {
        let wake!: () => void;
        const pending = new Promise<void>(resolve => { wake = resolve; });
        data.addEventListener("bufferedamountlow", wake, { once: true });
        try { await scope.wait(pending); } finally { data.removeEventListener("bufferedamountlow", wake); }
      }
      scope.check(); data.send(bytes.slice().buffer);
    } catch (error) { if (!this.#ended) this.abort(error); throw asLinkspanError(error); }
    finally { this.#sending = false; scope.dispose(); }
  }
  async receive(options: OperationOptions = {}): Promise<Uint8Array | null> {
    if (this.#receiving) throw new LinkspanError("protocol_error", "Only one WebRTC receive may be pending.");
    this.#receiving = true;
    const scope = createOperationScope(options);
    try {
      for (;;) {
        scope.check(); if (this.#error) throw this.#error;
        const next = this.#chunks.shift();
        if (next !== undefined) { this.#receivedBytes -= next.byteLength; return next; }
        if (this.#ended) return null;
        const pending = new Promise<void>(resolve => { this.#wake = resolve; });
        try { await scope.wait(pending); } finally { this.#wake = undefined; }
      }
    } catch (error) { if (!this.#ended) this.abort(error); throw asLinkspanError(error); }
    finally { this.#receiving = false; scope.dispose(); }
  }
}

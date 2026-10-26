import { createOperationScope, LinkspanError, asLinkspanError, type OperationOptions } from "@jokoagent/linkspan-core";
import type { StreamCarrier } from "@jokoagent/linkspan-core/stream";
import { HTTPParser } from "./connect-parser.js";

export const HTTP_CONNECT_LIMITS = Object.freeze({ maximumHeaderBytes: 16_384, maximumHeaders: 64,
  maximumInformationalResponses: 4, maximumChunkBytes: 128 * 1024, handshakeTimeoutMs: 10_000, closeTimeoutMs: 10_000 });

export interface HttpConnectOptions extends OperationOptions {
  /** One host-selected route, never an application URL, userinfo or headers. */
  readonly authority: string;
}

export function normalizeHttpConnectAuthority(value: string): string {
  if (typeof value !== "string" || value.length > 260 || /[\s/@?#%\\]/u.test(value)) throw invalid();
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):([1-9][0-9]{0,4})$/u.exec(value);
  if (match === null || Number(match[2]) > 65535) throw invalid();
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.hostname !== match[1] || String(Number(match[2])) !== match[2]) throw invalid();
    if (!match[1]!.startsWith("[") && !match[1]!.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) throw invalid();
  } catch { throw invalid(); }
  return value;
}

export function normalizeHttpConnectProxyOrigin(value: string): string {
  if (typeof value !== "string" || value.length > 2048) throw invalid();
  try {
    const url = new URL(value);
    if (!/^https?:$/u.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || url.origin !== value.replace(/\/$/u, "")) throw invalid();
    return url.origin;
  } catch { throw invalid(); }
}

function invalid(): LinkspanError { return new LinkspanError("invalid_argument", "HTTP CONNECT requires a fixed proxy origin and canonical host:port authority."); }
function protocol(cause?: unknown): LinkspanError { return new LinkspanError("protocol_error", "The selected HTTP CONNECT response is invalid.", { cause }); }

// The fixed parser only requires indexed bytes and this Buffer-compatible ASCII
// view for its status/header lines. HTTP parsing remains unmodified upstream.
function asciiView(bytes: Uint8Array): Buffer {
  const view = bytes.slice() as Uint8Array & { toString(encoding?: string, start?: number, end?: number): string };
  view.toString = (encoding: string = "ascii", start: number = 0, end: number = view.length): string => {
    if (encoding !== "ascii") throw protocol();
    let text = "";
    for (let index = start; index < end; index++) text += String.fromCharCode(view[index]! & 0x7f);
    return text;
  };
  return view as unknown as Buffer;
}

/** Establishes only an opaque carrier. A 2xx response never authenticates the
 * application endpoint; callers must next verify their independently pinned key. */
export async function negotiateHttpConnect(carrier: StreamCarrier, options: HttpConnectOptions): Promise<StreamCarrier> {
  let authority: string;
  try { authority = normalizeHttpConnectAuthority(options.authority); }
  catch (error) { const failure = asLinkspanError(error, "invalid_argument"); carrier.abort(failure); throw failure; }
  const scope = createOperationScope({ ...options, deadline: Math.min(options.deadline ?? Infinity, Date.now() + HTTP_CONNECT_LIMITS.handshakeTimeoutMs) });
  const cancel = (): void => carrier.abort(scope.signal.reason);
  scope.signal.addEventListener("abort", cancel, { once: true });
  let headerBytes = 0, informational = 0;
  const parser = new HTTPParser(HTTPParser.RESPONSE);
  parser.maxHeaderSize = HTTP_CONNECT_LIMITS.maximumHeaderBytes;
  let status: number | undefined;
  parser[HTTPParser.kOnHeadersComplete] = info => {
    if (info.versionMajor !== 1 || ![0, 1].includes(info.versionMinor)
      || info.headers.length > HTTP_CONNECT_LIMITS.maximumHeaders * 2) throw protocol();
    status = info.statusCode;
    return 2;
  };
  try {
    scope.check();
    await scope.wait(carrier.write(new TextEncoder().encode(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)));
    for (;;) {
      const bytes = await scope.wait(carrier.read());
      if (bytes === null) throw protocol();
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > HTTP_CONNECT_LIMITS.maximumChunkBytes) throw protocol();
      let offset = 0;
      while (offset < bytes.byteLength) {
        status = undefined;
        const remaining = HTTP_CONNECT_LIMITS.maximumHeaderBytes - headerBytes;
        if (remaining <= 0) throw protocol();
        const input = asciiView(bytes.subarray(offset, offset + remaining));
        const consumed = parser.execute(input, 0, input.byteLength);
        if (consumed instanceof Error || consumed < 1) throw protocol(consumed);
        headerBytes += consumed; offset += consumed;
        if (headerBytes > HTTP_CONNECT_LIMITS.maximumHeaderBytes) throw protocol();
        if (status === undefined) { if (headerBytes >= HTTP_CONNECT_LIMITS.maximumHeaderBytes) throw protocol(); continue; }
        if (status >= 100 && status < 200 && status !== 101) {
          if (++informational > HTTP_CONNECT_LIMITS.maximumInformationalResponses) throw protocol();
          continue;
        }
        if (status < 200 || status >= 300) throw new LinkspanError(status === 407 ? "authentication_failed" : "transport_error", "The HTTP CONNECT proxy refused the selected route.");
        scope.check();
        return ownStream(carrier, bytes.subarray(offset), options);
      }
    }
  } catch (error) {
    const failure = error instanceof LinkspanError ? error : protocol(error);
    carrier.abort(failure);
    throw failure;
  } finally { scope.signal.removeEventListener("abort", cancel); scope.dispose(); parser.close(); }
}

function ownStream(carrier: StreamCarrier, initial: Uint8Array, options: OperationOptions): StreamCarrier {
  const scope = createOperationScope(options);
  try { scope.check(); } catch (error) { scope.dispose(); throw error; }
  let remainder: Uint8Array | undefined = initial.byteLength > 0 ? initial.slice() : undefined;
  let reading = false, writing = false, ended = false;
  let writeTask: Promise<void> | undefined;
  let failure: LinkspanError | undefined, closing: Promise<void> | undefined;
  const dispose = (): void => { scope.signal.removeEventListener("abort", cancelled); scope.dispose(); };
  const abort = (reason?: unknown): void => {
    failure ??= reason === undefined ? new LinkspanError("cancelled", "The selected HTTP CONNECT carrier was cancelled.") : asLinkspanError(reason);
    ended = true; remainder = undefined; carrier.abort(failure); dispose();
  };
  const cancelled = (): void => abort(scope.signal.reason);
  scope.signal.addEventListener("abort", cancelled, { once: true });
  if (scope.signal.aborted) cancelled();
  return {
    async read() {
      if (reading) throw new LinkspanError("invalid_argument", "Only one carrier read may be pending.");
      if (failure !== undefined) throw failure;
      if (remainder !== undefined) { const bytes = remainder; remainder = undefined; return bytes; }
      if (ended) return null;
      reading = true;
      try {
        scope.check();
        const bytes = await scope.wait(carrier.read());
        if (bytes !== null && (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > HTTP_CONNECT_LIMITS.maximumChunkBytes)) throw protocol();
        return bytes;
      } catch (error) {
        // An owned graceful close may make an outstanding native read fail.
        // Preserve its error for the reader without cancelling the close owner.
        const normalized = asLinkspanError(error);
        if (closing === undefined || !["closed", "cancelled", "transport_error"].includes(normalized.code)) abort(normalized);
        throw normalized;
      } finally { reading = false; }
    },
    async write(bytes) {
      if (failure !== undefined) throw failure;
      if (ended || closing !== undefined) throw new LinkspanError("closed", "The HTTP CONNECT carrier is closing.");
      if (writing) throw new LinkspanError("resource_exhausted", "Only one carrier write may be pending.");
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > HTTP_CONNECT_LIMITS.maximumChunkBytes) throw invalid();
      writing = true;
      const copy = bytes.slice();
      const pending = Promise.resolve().then(async () => { scope.check(); await carrier.write(copy); });
      writeTask = pending;
      try { await scope.wait(pending); }
      catch (error) { abort(error); throw asLinkspanError(error); }
      finally { writing = false; if (writeTask === pending) writeTask = undefined; }
    },
    close() {
      return closing ??= (async () => {
        const closeScope = createOperationScope({ signal: scope.signal, deadline: Math.min(options.deadline ?? Infinity, Date.now() + HTTP_CONNECT_LIMITS.closeTimeoutMs) });
        try {
          closeScope.check();
          if (failure !== undefined) throw failure;
          if (writeTask !== undefined) await closeScope.wait(writeTask);
          await closeScope.wait(carrier.close());
          ended = true;
        } catch (error) { abort(error); throw asLinkspanError(error); }
        finally { closeScope.dispose(); dispose(); }
      })();
    },
    abort
  };
}

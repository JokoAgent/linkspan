import { request as httpRequest } from "node:http";
import { once } from "node:events";
import type { ByteChannel, OperationOptions } from "@jokoagent/linkspan-core";
import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import { HEAD, RESPONSE, metadata, parseHeaders, parseMetadata, readRecord, receiveBody, sendBody, wireHeaders } from "./wire.js";

export interface ServeHttpOptions extends OperationOptions {
  /** Explicit, fixed local application origin; never supplied by the remote peer. */
  readonly origin: string;
  /** Host authorization and revocation registration, called before dispatch. */
  readonly authorize?: (request: { readonly method: string; readonly target: string; readonly headers: Headers; readonly channel: ByteChannel }) => void | (() => void);
}

/** Bridges one verified channel to the host's existing loopback HTTP handlers. */
export async function serveHttp(channel: ByteChannel, options: ServeHttpOptions): Promise<void> {
  let origin: URL;
  try { origin = new URL(options.origin); }
  catch (cause) { throw new LinkspanError("invalid_argument", "Only an explicit loopback application origin is allowed.", { cause }); }
  if (origin.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(origin.hostname)
    || origin.origin !== options.origin || origin.username || origin.password) throw new LinkspanError("invalid_argument", "Only an explicit loopback application origin is allowed.");
  const scope = createOperationScope(options);
  const cancel = (): void => channel.abort(scope.signal.reason);
  scope.signal.addEventListener("abort", cancel, { once: true });
  let dispose: (() => void) | undefined;
  let outgoing: ReturnType<typeof httpRequest> | undefined;
  try {
    scope.check();
    const head = parseMetadata(await readRecord(channel, { ...options, deadline: Math.min(options.deadline ?? Infinity, Date.now() + 10_000) }), HEAD);
    const method = head["method"];
    const target = head["target"];
    if (head["version"] !== 1 || typeof method !== "string" || !/^[A-Z]{1,16}$/u.test(method)
      || typeof target !== "string" || target.length > 8192 || !target.startsWith("/") || target.startsWith("//")
      || /[\r\n\0\\#]/u.test(target)) throw new Error("Invalid HTTP request target.");
    const url = new URL(target, origin);
    if (url.origin !== origin.origin) throw new Error("HTTP target escaped the configured application.");
    const header = parseHeaders(head["headers"]);
    dispose = options.authorize?.({ method, target, headers: header, channel }) ?? undefined;
    const headers = Object.fromEntries(wireHeaders(header));
    // No caller-selected proxy, redirect, DNS destination, or inherited agent.
    outgoing = httpRequest(url, { method, headers, agent: false, signal: scope.signal });
    const current = outgoing;
    let liveResponse: import("node:http").IncomingMessage | undefined;
    void channel.closed.then(result => {
      const error = result.error ?? new Error("The verified HTTP channel closed.");
      if (liveResponse !== undefined && !liveResponse.complete) liveResponse.destroy(error);
      if (!current.destroyed) current.destroy(error);
    });
    const responsePromise = new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
      const cleanup = (): void => { current.removeListener("response", received); current.removeListener("error", failed); current.removeListener("close", closed); };
      const received = (response: import("node:http").IncomingMessage): void => { liveResponse = response; cleanup(); resolve(response); };
      const failed = (error: Error): void => { cleanup(); reject(error); };
      const closed = (): void => { cleanup(); reject(new Error("The local HTTP request closed before a response.")); };
      current.once("response", received);
      current.once("error", failed);
      current.once("close", closed);
    });
    // Destroying a completed request can still emit an error while its response drains.
    current.on("error", () => undefined);
    const upload = (async () => {
      const trailers = new Headers();
      for await (const bytes of receiveBody(channel, trailers, options)) {
        if (!current.write(bytes)) await once(current, "drain", options.signal === undefined ? {} : { signal: options.signal });
      }
      if ([...trailers].length > 0) current.addTrailers(Object.fromEntries(wireHeaders(trailers)));
      current.end();
    })();
    void upload.catch(error => { current.destroy(error instanceof Error ? error : new Error("HTTP upload failed.")); channel.abort(error); });
    const response = await responsePromise;
    const responseHeaders = new Headers();
    for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
    await channel.send(metadata(RESPONSE, { status: response.statusCode, headers: wireHeaders(responseHeaders) }), options);
    async function* responseBody(): AsyncGenerator<Uint8Array> {
      for await (const bytes of response) yield bytes as Uint8Array;
    }
    // HTTP trailers become available only after the response body is consumed.
    const trailers = new Headers();
    async function* bodyWithTrailers(): AsyncGenerator<Uint8Array> {
      yield* responseBody();
      for (const [key, value] of Object.entries(response.trailers)) {
        if (value !== undefined) trailers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
    }
    await sendBody(channel, bodyWithTrailers(), trailers, options);
    // Keep the encrypted END observable until the peer acknowledges/tears down.
    await channel.close();
  } catch (error) {
    const failure = asLinkspanError(scope.signal.aborted ? scope.signal.reason : error, "protocol_error");
    // Error cleanup must not depend on the peer reading another message. Its
    // receive window may be exhausted, including while authorization is revoked.
    channel.abort(failure);
    throw failure;
  } finally {
    outgoing?.destroy();
    try { dispose?.(); }
    finally {
      scope.signal.removeEventListener("abort", cancel);
      scope.dispose();
    }
  }
}

import type { ByteChannel, OperationOptions } from "@jokoagent/linkspan-core";
import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import { HEAD, RESPONSE, metadata, parseHeaders, parseMetadata, readRecord, receiveBody, sendBody, wireHeaders } from "./wire.js";
import { fetchResponse, readFetchRequest } from "./fetch-body.js";

export interface HttpRequest extends OperationOptions {
  readonly url: string;
  readonly method: string;
  readonly header: Headers;
  readonly body?: AsyncIterable<Uint8Array>;
}

export interface HttpResponse {
  readonly status: number;
  readonly header: Headers;
  readonly body: AsyncIterable<Uint8Array>;
  /** Filled as the body reaches its authenticated END record. */
  readonly trailer: Headers;
  readonly cancel: (reason?: unknown) => void;
}

export interface HttpClientOptions {
  readonly origin: string;
  /** Must return a channel whose endpoint identity has already been verified. */
  readonly connect: (options: OperationOptions) => Promise<ByteChannel>;
}

/** One request per verified channel. Never redirects or replays requests. */
export function createHttpClient(options: HttpClientOptions): (request: HttpRequest) => Promise<HttpResponse> {
  const origin = validateOrigin(options.origin);
  return async request => {
    const lifetime = createOperationScope(request);
    const scope = { signal: lifetime.signal, ...(request.deadline === undefined ? {} : { deadline: request.deadline }) };
    let channel: ByteChannel;
    let connected: ByteChannel | undefined;
    let url: URL;
    try {
      lifetime.check();
      try { url = new URL(request.url); }
      catch (cause) { throw new LinkspanError("invalid_argument", "A valid HTTP request URL is required.", { cause }); }
      if (url.origin !== origin || url.username || url.password || url.hash) throw new LinkspanError("invalid_argument", "HTTP request does not match its pinned origin.");
      if (!/^[A-Z]{1,16}$/u.test(request.method)) throw new LinkspanError("invalid_argument", "Invalid HTTP method.");
      const connecting = options.connect(scope).then(late => {
        connected = late;
        if (lifetime.signal.aborted) late.abort(lifetime.signal.reason);
        return late;
      });
      channel = await lifetime.wait(connecting);
    } catch (error) {
      const failure = asLinkspanError(error);
      connected?.abort(failure);
      lifetime.dispose();
      throw failure;
    }
    let complete = false;
    let retiring = false;
    let retired = false;
    const abortChannel = (reason: unknown): void => { if (!retired) { retired = true; channel.abort(reason); } };
    const uploadLifetime = new AbortController();
    const aborted = (): void => { uploadLifetime.abort(lifetime.signal.reason); abortChannel(lifetime.signal.reason); };
    lifetime.signal.addEventListener("abort", aborted, { once: true });
    if (lifetime.signal.aborted) aborted();
    const cleanup = (): void => {
      retiring = true;
      uploadLifetime.abort(new LinkspanError("cancelled", "The HTTP upload lifetime ended."));
      lifetime.signal.removeEventListener("abort", aborted);
      lifetime.dispose();
    };
    const channelClosed = (): void => { retired = true; cleanup(); };
    void channel.closed.then(channelClosed, channelClosed);
    const uploadScope = { ...scope, signal: uploadLifetime.signal };
    const upload = (async () => {
      await channel.send(metadata(HEAD, { version: 1, method: request.method, target: url.pathname + url.search, headers: wireHeaders(request.header) }), scope);
      await sendBody(channel, request.body, new Headers(), uploadScope);
    })();
    // Both directions must run concurrently for client streaming and early responses.
    void upload.catch(error => { if (!complete && !retiring) abortChannel(asLinkspanError(error)); });
    try {
      const head = parseMetadata(await readRecord(channel, scope), RESPONSE);
      if (!Number.isInteger(head["status"]) || (head["status"] as number) < 200 || (head["status"] as number) > 599) {
        throw new LinkspanError("protocol_error", "Invalid HTTP response status.");
      }
      const header = parseHeaders(head["headers"]);
      const trailer = new Headers();
      async function* body(): AsyncGenerator<Uint8Array> {
        try {
          yield* receiveBody(channel, trailer, scope);
          // An early final response may finish before an endless upload. Do not
          // wait for the upload before making the response completion visible.
          complete = true;
          uploadLifetime.abort(new LinkspanError("cancelled", "The HTTP response completed before its upload."));
          await channel.close();
        } catch (error) {
          const failure = asLinkspanError(lifetime.signal.aborted ? lifetime.signal.reason : error, "protocol_error");
          abortChannel(failure);
          throw failure;
        } finally {
          cleanup();
          if (!complete) abortChannel(new LinkspanError("cancelled", "HTTP response body was cancelled."));
        }
      }
      return { status: head["status"] as number, header, trailer, body: body(),
        cancel: reason => { cleanup(); abortChannel(asLinkspanError(reason, "cancelled")); } };
    } catch (error) {
      const failure = asLinkspanError(lifetime.signal.aborted ? lifetime.signal.reason : error, "protocol_error");
      cleanup();
      abortChannel(failure);
      throw failure;
    }
  };
}

/** Fetch-compatible boundary for browser/Expo consumers; response bodies stream. */
export function createHttpFetch(options: HttpClientOptions): typeof globalThis.fetch {
  const client = createHttpClient(options);
  return async (input, init) => {
    const request = readFetchRequest(input, init);
    const controller = new AbortController();
    const ownerAbort = (): void => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", ownerAbort, { once: true });
    if (request.signal?.aborted) ownerAbort();
    const reader = request.body?.getReader();
    const cancelUpload = (): void => { void reader?.cancel().catch(() => undefined); };
    controller.signal.addEventListener("abort", cancelUpload, { once: true });
    const cleanup = (): void => {
      request.signal?.removeEventListener("abort", ownerAbort);
      controller.signal.removeEventListener("abort", cancelUpload);
    };
    async function* requestBody(): AsyncGenerator<Uint8Array> {
      if (reader === undefined) return;
      try {
        for (;;) {
          const value = await reader.read();
          if (value.done) return;
          yield value.value;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
      }
    }
    let result: HttpResponse;
    try {
      result = await client({ url: request.url, method: request.method, header: request.headers,
        ...(reader === undefined ? {} : { body: requestBody() }), signal: controller.signal });
    } catch (error) { cancelUpload(); cleanup(); throw error; }
    const iterator = result.body[Symbol.asyncIterator]();
    const noBody = request.method === "HEAD" || result.status === 204 || result.status === 205 || result.status === 304;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await iterator.next();
          if (next.done) { cancelUpload(); cleanup(); controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) { cancelUpload(); cleanup(); controller.error(error); }
      },
      async cancel() {
        const reason = new Error("The HTTP body was cancelled.");
        controller.abort(reason); result.cancel(reason); cancelUpload(); cleanup(); await iterator.return?.();
      }
    }, { highWaterMark: 0 });
    if (noBody) {
      // Consume the authenticated END even when Fetch does not expose a body.
      try {
        for await (const chunk of result.body) if (chunk.length > 0) {
          const failure = new LinkspanError("protocol_error", "Unexpected HTTP response body.");
          result.cancel(failure);
          throw failure;
        }
      } catch (error) {
        const failure = asLinkspanError(error, "protocol_error");
        result.cancel(failure);
        throw failure;
      } finally { cancelUpload(); cleanup(); }
    }
    return fetchResponse(noBody ? null : body, result.status, result.header, request.url);
  };
}

function validateOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch (cause) { throw new LinkspanError("invalid_argument", "An exact HTTP origin is required.", { cause }); }
  if (!/^https?:$/u.test(url.protocol) || value !== url.origin || url.username || url.password) throw new LinkspanError("invalid_argument", "An exact HTTP origin is required.");
  return url.origin;
}

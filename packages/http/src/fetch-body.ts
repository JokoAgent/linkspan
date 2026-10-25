/** Avoid React Native's Request implementation, which buffers streaming bodies. */
export function readFetchRequest(input: RequestInfo | URL, init?: RequestInit) {
  const source = typeof input === "string" || input instanceof URL ? undefined : input;
  const url = source?.url ?? String(input);
  const method = (init?.method ?? source?.method ?? "GET").toUpperCase();
  const headers = new Headers(init?.headers ?? source?.headers);
  const signal = init?.signal ?? source?.signal;
  const body = init?.body === undefined ? source?.body : init.body;
  if ((method === "GET" || method === "HEAD") && body !== undefined && body !== null) throw new TypeError("This HTTP method cannot carry a body.");
  return { url, method, headers, signal, body: byteBody(body, headers) };
}

function byteBody(body: BodyInit | null | undefined, headers: Headers): ReadableStream<Uint8Array> | undefined {
  if (body === null || body === undefined) return;
  if (typeof (body as ReadableStream).getReader === "function") return body as ReadableStream<Uint8Array>;
  if (typeof body === "string") {
    if (!headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
    return oneChunk(new TextEncoder().encode(body));
  }
  if (body instanceof URLSearchParams) {
    if (!headers.has("content-type")) headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
    return oneChunk(new TextEncoder().encode(body.toString()));
  }
  if (body instanceof ArrayBuffer) return oneChunk(new Uint8Array(body));
  if (ArrayBuffer.isView(body)) return oneChunk(new Uint8Array(body.buffer, body.byteOffset, body.byteLength));
  if (typeof Blob !== "undefined" && body instanceof Blob && typeof body.stream === "function") {
    if (body.type && !headers.has("content-type")) headers.set("content-type", body.type);
    return body.stream();
  }
  throw new TypeError("Use a byte buffer, text, Blob stream, or ReadableStream for this secure HTTP request.");
}

function oneChunk(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
}

/** Native Response on Web/Node, streaming facade on RN's non-streaming polyfill. */
export function fetchResponse(body: ReadableStream<Uint8Array> | null, status: number, headers: Headers, url: string): Response {
  if (hasStreamingResponse()) return new Response(body, { status, headers });
  let consumed = false;
  const consume = async (): Promise<Uint8Array> => {
    if (consumed || body?.locked) throw new TypeError("Response body has already been consumed.");
    consumed = true;
    if (body === null) return new Uint8Array();
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        chunks.push(next.value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  };
  const response = {
    body, status, statusText: "", headers, ok: status >= 200 && status < 300, url, redirected: false, type: "basic",
    get bodyUsed() { return consumed || (body?.locked ?? false); },
    arrayBuffer: async () => (await consume()).buffer,
    bytes: consume,
    text: async () => new TextDecoder().decode(await consume()),
    json: async () => JSON.parse(new TextDecoder().decode(await consume())) as unknown,
    blob: async () => new Blob([(await consume()).buffer as ArrayBuffer], { type: headers.get("content-type") ?? "" }),
    formData: async () => { throw new TypeError("Multipart parsing is unavailable in this runtime's streaming response."); },
    clone: () => { throw new TypeError("Consume the secure response once in this runtime."); }
  };
  return response as Response;
}

let streamingResponse: boolean | undefined;
function hasStreamingResponse(): boolean {
  if (streamingResponse === undefined) {
    try {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
      streamingResponse = typeof new Response(stream).body?.getReader === "function";
    } catch { streamingResponse = false; }
  }
  return streamingResponse;
}

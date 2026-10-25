import type { ByteChannel, OperationOptions } from "@jokoagent/linkspan-core";
import { createOperationScope } from "@jokoagent/linkspan-core";

export const HEAD = 0;
export const DATA = 1;
export const END = 2;
export const RESPONSE = 3;
export const FAILURE = 4;
export const CHUNK_BYTES = 16 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function metadata(kind: number, value: unknown): Uint8Array {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > MAX_METADATA_BYTES) throw new Error("HTTP metadata exceeds its limit.");
  return record(kind, bytes);
}

export function record(kind: number, bytes: Uint8Array = new Uint8Array()): Uint8Array {
  const frame = new Uint8Array(bytes.length + 1);
  frame[0] = kind;
  frame.set(bytes, 1);
  return frame;
}

export async function readRecord(channel: ByteChannel, options?: OperationOptions): Promise<Uint8Array> {
  const frame = await channel.receive(options);
  if (frame === null) throw new Error("HTTP stream ended without a completion record.");
  if (frame.length < 1 || frame.length > MAX_METADATA_BYTES + 1) throw new Error("Invalid HTTP record size.");
  if (frame[0] === FAILURE) throw new Error("The remote HTTP request failed.");
  return frame;
}

export function parseMetadata(frame: Uint8Array, kind: number): Record<string, unknown> {
  if (frame[0] !== kind || frame.length > MAX_METADATA_BYTES + 1) throw new Error("Invalid HTTP metadata record.");
  const value: unknown = JSON.parse(decoder.decode(frame.subarray(1)));
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid HTTP metadata.");
  return value as Record<string, unknown>;
}

export function parseHeaders(value: unknown): Headers {
  if (!Array.isArray(value) || value.length > 128) throw new Error("Invalid HTTP headers.");
  const headers = new Headers();
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || typeof pair[1] !== "string") {
      throw new Error("Invalid HTTP header.");
    }
    if (pair[0].length > 256 || pair[1].length > 8192 || /[\r\n\0]/u.test(pair[0] + pair[1])) throw new Error("Invalid HTTP header.");
    headers.append(pair[0], pair[1]);
  }
  return headers;
}

const HOP_HEADERS = new Set(["connection", "proxy-connection", "keep-alive", "transfer-encoding", "upgrade", "host", "proxy-authorization", "proxy-authenticate", "te"]);
export function wireHeaders(headers: Headers): [string, string][] {
  const connection = new Set((headers.get("connection") ?? "").toLowerCase().split(",").map(value => value.trim()));
  return [...headers].filter(([name]) => !HOP_HEADERS.has(name) && !connection.has(name));
}

export async function sendBody(channel: ByteChannel, body: AsyncIterable<Uint8Array> | undefined, trailer = new Headers(), options?: OperationOptions): Promise<void> {
  const scope = createOperationScope(options);
  const iterator = body?.[Symbol.asyncIterator]();
  let consumed = false;
  try {
    scope.check();
    while (iterator !== undefined) {
      const next = await scope.wait(iterator.next());
      if (next.done) { consumed = true; break; }
      const chunk = next.value;
      if (!(chunk instanceof Uint8Array)) throw new Error("HTTP body must contain bytes.");
      for (let offset = 0; offset < chunk.length; offset += CHUNK_BYTES) {
        await channel.send(record(DATA, chunk.subarray(offset, offset + CHUNK_BYTES)), options);
      }
    }
    await channel.send(metadata(END, { headers: wireHeaders(trailer) }), options);
  } finally {
    scope.dispose();
    // A host iterator can be waiting on its own work. Request cancellation must
    // release the transport without waiting for an uncooperative producer.
    if (!consumed && iterator?.return !== undefined) void Promise.resolve().then(() => iterator.return!()).catch(() => undefined);
  }
}

export async function* receiveBody(channel: ByteChannel, trailer: Headers, options?: OperationOptions): AsyncGenerator<Uint8Array> {
  for (;;) {
    const frame = await readRecord(channel, options);
    if (frame[0] === END) {
      for (const [key, value] of parseHeaders(parseMetadata(frame, END)["headers"])) trailer.append(key, value);
      return;
    }
    if (frame[0] !== DATA || frame.length > CHUNK_BYTES + 1) throw new Error("Invalid HTTP body record.");
    if (frame.length > 1) yield frame.subarray(1);
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { LinkspanError } from "../dist/index.js";
import { createStreamBridgeHost, connectStreamBridge,createResourcePool } from "../dist/stream.js";

test("trusted local bridges transfer bounded bytes and reject unsupported methods", async () => {
  let bytes;
  let closed = false;
  const host = createStreamBridgeHost(async () => ({ remoteEndpointId: "trusted-id", async write(value) { bytes = value; }, async read() { return bytes ?? null; }, async close() { closed = true; }, abort() { closed = true; } }));
  const client = await connectStreamBridge(host, {});
  await client.write(Uint8Array.of(0,255,17));
  assert.deepEqual(await client.read(), Uint8Array.of(0,255,17));
  await assert.rejects(client.write(new Uint8Array(128 * 1024 + 1)), error => error.code === "invalid_argument");
  await assert.rejects(host.request({ method: "shell", streamId: "a".repeat(32) }), error => error.code === "closed");
  await client.close(); assert.equal(closed,true); host.dispose();
});

test("bridge cancellation releases a late connection and keeps secrets out of errors", async () => {
  let start;
  let aborted = false;
  const host = createStreamBridgeHost(async () => {
    await new Promise(resolve => { start = resolve; });
    return { remoteEndpointId: "secret-locator", read: async () => null, write: async () => {}, close: async () => {}, abort() { aborted = true; } };
  });
  const controller = new AbortController();
  const pending = connectStreamBridge(host, { address: "secret-locator" }, { signal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort(); start();
  await assert.rejects(pending,error => error.code === "cancelled" && !error.message.includes("secret-locator"));
  await new Promise(resolve => setImmediate(resolve)); assert.equal(aborted,true); host.dispose();
});

test("opened bridge close preserves its carrier lifetime until actual graceful retirement", async () => {
  let signal, releaseClose, closeCalls = 0;
  const host = createStreamBridgeHost(async (_args, options) => {
    signal = options.signal;
    return { remoteEndpointId: "trusted-id", read: async () => new Promise(() => {}), write: async () => {}, abort() {},
      async close() {
        closeCalls++;
        assert.equal(signal.aborted, false);
        await new Promise(resolve => { releaseClose = resolve; });
        assert.equal(signal.aborted, false);
      } };
  });
  const client = await connectStreamBridge(host, {});
  const reading = assert.rejects(client.read(), { code: "cancelled" });
  await new Promise(resolve => setImmediate(resolve));
  const first = client.close(), second = client.close();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, false); assert.equal(closeCalls, 1);
  await assert.rejects(client.write(Uint8Array.of(1)), { code: "closed" });
  releaseClose(); await Promise.all([first, second, reading]);
  assert.equal(signal.aborted, true); host.dispose();
});

test("pending dial close cancels promptly and aborts the original late stream", async () => {
  const streamId = "b".repeat(32);
  let releaseDial, signal, aborted = 0, closed = 0;
  const host = createStreamBridgeHost(async (_args, options) => {
    signal = options.signal;
    await new Promise(resolve => { releaseDial = resolve; });
    return { remoteEndpointId: "trusted-id", read: async () => null, write: async () => {},
      async close() { closed++; }, abort() { aborted++; } };
  });
  const connecting = assert.rejects(host.request({ method: "connect", streamId }), { code: "cancelled" });
  await new Promise(resolve => setImmediate(resolve));
  await host.request({ method: "close", streamId });
  assert.equal(signal.aborted, true);
  await assert.rejects(host.request({ method: "write", streamId, args: [1] }), { code: "closed" });
  releaseDial(); await connecting;
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(aborted > 0); assert.equal(closed, 0); host.dispose();
});

test("explicit abort interrupts a closing stream and its concurrent read and write", async () => {
  let releaseClose, signal, aborted = 0;
  const host = createStreamBridgeHost(async (_args, options) => {
    signal = options.signal;
    return { remoteEndpointId: "trusted-id", read: async () => new Promise(() => {}), write: async () => new Promise(() => {}),
      close: () => new Promise(resolve => { releaseClose = resolve; }), abort() { aborted++; } };
  });
  const client = await connectStreamBridge(host, {});
  const reading = assert.rejects(client.read(), { code: "cancelled" });
  const writing = assert.rejects(client.write(Uint8Array.of(1)), { code: "cancelled" });
  await new Promise(resolve => setImmediate(resolve));
  const closing = assert.rejects(client.close(), { code: "cancelled" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, false);
  client.abort(); await Promise.all([reading, writing, closing]);
  assert.equal(signal.aborted, true); assert.ok(aborted > 0);
  releaseClose(); host.dispose();
});

test("failed graceful close rejects with its original code and retires the owned stream", async () => {
  let aborted = false;
  const failure = new LinkspanError("protocol_error", "Controlled close failure");
  const host = createStreamBridgeHost(async () => ({ remoteEndpointId: "trusted-id", read: async () => null, write: async () => {},
    close: async () => { throw failure; }, abort() { aborted = true; } }));
  const client = await connectStreamBridge(host, {});
  await assert.rejects(client.close(), error => error === failure);
  assert.equal(aborted, true); host.dispose();
});

test("graceful close has one bounded deadline and disposal interrupts it", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  let aborted = 0;
  const host = createStreamBridgeHost(async () => ({ remoteEndpointId: "trusted-id", read: async () => null, write: async () => {},
    close: async () => new Promise(() => {}), abort() { aborted++; } }));
  const first = await connectStreamBridge(host, {});
  const timeout = assert.rejects(first.close(), { code: "deadline_exceeded" });
  await new Promise(resolve => setImmediate(resolve));
  t.mock.timers.tick(30_000); await timeout;
  assert.equal(aborted, 1);
  const second = await connectStreamBridge(host, {});
  const disposed = assert.rejects(second.close(), { code: "cancelled" });
  await new Promise(resolve => setImmediate(resolve));
  host.dispose(); await disposed;
  assert.ok(aborted >= 2);
});

test("concurrent streams share one SDK identity and release only their own reference",async()=>{
  let creates=0,closes=0;const value={};const pool=createResourcePool(async item=>{assert.equal(item,value);closes++;});
  const create=async()=>{creates++;return value;};const[a,b]=await Promise.all([pool.acquire("identity",create,{configuration:"relay"}),pool.acquire("identity",create,{configuration:"relay"})]);
  assert.equal(creates,1);await a.release();assert.equal(closes,0);
  await assert.rejects(pool.acquire("identity",create,{configuration:"different"}),error=>error.code==="invalid_argument");
  await b.release();await b.release();assert.equal(closes,1);
});

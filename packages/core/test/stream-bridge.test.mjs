import test from "node:test";
import assert from "node:assert/strict";
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

test("concurrent streams share one SDK identity and release only their own reference",async()=>{
  let creates=0,closes=0;const value={};const pool=createResourcePool(async item=>{assert.equal(item,value);closes++;});
  const create=async()=>{creates++;return value;};const[a,b]=await Promise.all([pool.acquire("identity",create,{configuration:"relay"}),pool.acquire("identity",create,{configuration:"relay"})]);
  assert.equal(creates,1);await a.release();assert.equal(closes,0);
  await assert.rejects(pool.acquire("identity",create,{configuration:"different"}),error=>error.code==="invalid_argument");
  await b.release();await b.release();assert.equal(closes,1);
});

import test from "node:test";
import assert from "node:assert/strict";
import { createServer, connect } from "node:net";
import { once } from "node:events";
import { createIdentity, connectStream, acceptStream } from "../dist/index.js";

function carrier(socket, capture) {
  const iterator = socket[Symbol.asyncIterator]();
  return {
    async read() { const item = await iterator.next(); return item.done ? null : new Uint8Array(item.value); },
    async write(bytes) {
      capture?.push(...bytes);
      // Deliberately split a byte stream at unrelated packet boundaries.
      for (let offset = 0; offset < bytes.length; offset += 113) {
        await new Promise((resolve, reject) => socket.write(bytes.subarray(offset, offset + 113), error => error ? reject(error) : resolve()));
      }
    },
    async close() { socket.end(); if (!socket.closed) await once(socket, "close"); },
    abort() { socket.destroy(); },
  };
}
async function fixture(t) {
  const identity = await createIdentity();
  const server = createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const accepted = once(server, "connection");
  const client = connect(server.address().port, "127.0.0.1"); await once(client, "connect");
  const [remote] = await accepted;
  t.after(() => { client.destroy(); remote.destroy(); server.close(); });
  const wire = [];
  return { identity, wire, client: carrier(client, wire), server: carrier(remote, wire) };
}

test("ordered SDK carriers retain Noise identity, boundaries, flow control and authenticated close", async t => {
  const setup = await fixture(t);
  const incoming = acceptStream(setup.server, { identity: setup.identity });
  const outgoing = await connectStream(setup.client, { expectedPublicKey: setup.identity.publicKey });
  const remote = await incoming;
  const payload = new TextEncoder().encode("private application bytes ".repeat(2000));
  await outgoing.send(payload);
  assert.deepEqual(await remote.receive(), payload);
  assert.equal(new TextDecoder().decode(Uint8Array.from(setup.wire)).includes("private application bytes"), false);
  await outgoing.close();
  assert.deepEqual(await outgoing.closed, {});
  assert.deepEqual(await remote.closed, {});
});

test("a replaced SDK endpoint is rejected before application data is accepted", async t => {
  const setup = await fixture(t);
  const other = await createIdentity();
  const accepted = acceptStream(setup.server, { identity: setup.identity }).catch(() => undefined);
  await assert.rejects(connectStream(setup.client, { expectedPublicKey: other.publicKey }), error => error.code === "identity_mismatch");
  (await accepted)?.abort();
});

test("an SDK rejecting its pending read during orderly close preserves the authenticated close result",async t=>{
  const setup=await fixture(t);let rejectPending;
  const read=setup.client.read.bind(setup.client);const close=setup.client.close.bind(setup.client);
  setup.client.read=()=>Promise.race([read(),new Promise((_,reject)=>{rejectPending=reject;})]);
  setup.client.close=async()=>{rejectPending?.(new Error("SDK connection closed"));await new Promise(resolve=>setImmediate(resolve));await close();};
  const accepted=acceptStream(setup.server,{identity:setup.identity});
  const client=await connectStream(setup.client,{expectedPublicKey:setup.identity.publicKey});const peer=await accepted;
  await client.close();assert.deepEqual(await client.closed,{});assert.deepEqual(await peer.closed,{});
});

test("SDK carrier cancellation interrupts an incomplete security handshake", async t => {
  const setup = await fixture(t);
  const controller = new AbortController();
  const pending = connectStream(setup.client, { expectedPublicKey: setup.identity.publicKey, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.code === "cancelled");
});

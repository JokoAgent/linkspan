import assert from 'node:assert/strict';
import { createServer, connect } from 'node:net';
import { once } from 'node:events';
import test from 'node:test';
import { createNodeStreamCarrier, NODE_STREAM_LIMITS } from '../dist/node.js';
import { createIdentity, connectStream, acceptStream } from '@jokoagent/linkspan-noise';

async function pair(t, options = {}) {
  const sockets = new Set();
  const listener = createServer({ allowHalfOpen: true, pauseOnConnect: true });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => listener.close(resolve)); });
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const accepted = once(listener, 'connection');
  const clientSocket = connect({ host: '127.0.0.1', port: listener.address().port, allowHalfOpen: true });
  sockets.add(clientSocket);
  await once(clientSocket, 'connect');
  const [serverSocket] = await accepted;
  sockets.add(serverSocket);
  const client = createNodeStreamCarrier(clientSocket, options);
  const server = createNodeStreamCarrier(serverSocket);
  return { client, server, clientSocket, serverSocket };
}

test('owned Node sockets carry actual Noise identity and binary traffic with graceful bidirectional EOF', { timeout: 10000 }, async t => {
  const { client: rawClient, server: rawServer } = await pair(t);
  const identity = await createIdentity();
  const accepted = acceptStream(rawServer, { identity });
  const client = await connectStream(rawClient, { expectedPublicKey: identity.publicKey });
  const server = await accepted;
  const payload = new Uint8Array(2 * 1024 * 1024).map((_, index) => index % 251);
  const receiving = (async () => {
    const received = [];
    for (let count = 0; count < payload.length; ) {
      const bytes = await server.receive(); assert.ok(bytes); received.push(bytes); count += bytes.length;
    }
    return Buffer.concat(received);
  })();
  for (let offset = 0; offset < payload.length; offset += 32768) await client.send(payload.subarray(offset, offset + 32768));
  assert.deepEqual(await receiving, Buffer.from(payload));
  const clientEof = client.receive(), serverEof = server.receive();
  await Promise.all([client.close(), server.close()]);
  assert.equal(await clientEof, null);
  assert.equal(await serverEof, null);
});

test('HTTP-parser remainder bytes survive socket EOF and are consumed before subsequent bytes', { timeout: 3000 }, async t => {
  const initialData = new Uint8Array([0, 255, 17]);
  const { client, server } = await pair(t, { initialData });
  initialData.fill(4);
  await server.write(new Uint8Array([19, 20]));
  const closing = server.close();
  assert.deepEqual(await client.read(), new Uint8Array([0, 255, 17]));
  assert.deepEqual(await client.read(), new Uint8Array([19, 20]));
  assert.equal(await client.read(), null);
  await client.close();
  await closing;
});

test('owner cancellation interrupts graceful close and its pending read without accepting a replacement owner', { timeout: 3000 }, async t => {
  const owner = new AbortController();
  const { client } = await pair(t, { signal: owner.signal });
  const read = client.read(), close = client.close();
  const checks = [assert.rejects(read, { code: 'cancelled' }), assert.rejects(close, { code: 'cancelled' })];
  owner.abort();
  await Promise.all(checks);
});

test('a native reset fails a pending read rather than synthesizing orderly EOF', { timeout: 3000 }, async t => {
  const { client, serverSocket } = await pair(t);
  const read = assert.rejects(client.read(), { code: 'transport_error' });
  serverSocket.resetAndDestroy();
  await read;
  await assert.rejects(client.close(), { code: 'transport_error' });
});

test('stream bounds and simultaneous operations reject before queuing additional native writes', { timeout: 3000 }, async t => {
  const { client, server } = await pair(t);
  await assert.rejects(client.write(new Uint8Array(NODE_STREAM_LIMITS.maximumChunkBytes + 1)), { code: 'invalid_argument' });
  const read = client.read();
  await assert.rejects(client.read(), { code: 'invalid_argument' });
  const write = client.write(new Uint8Array([1]));
  await assert.rejects(client.write(new Uint8Array([2])), { code: 'resource_exhausted' });
  await write;
  assert.deepEqual(await server.read(), new Uint8Array([1]));
  client.abort();
  await assert.rejects(read, { code: 'cancelled' });
  server.abort();
});

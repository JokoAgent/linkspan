import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, connect as connectTcp } from 'node:net';
import { createServer as createTlsServer } from 'node:tls';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connectHttpConnectStream, createNodeStreamCarrier } from '../dist/node.js';
import { createIdentity, acceptStream, connectStream } from '@jokoagent/linkspan-noise';
import { createHttpFetch } from '@jokoagent/linkspan-http';
import { serveHttp } from '@jokoagent/linkspan-http/node';

async function listen(t, server, sockets) {
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, handler) {
  const sockets = new Set(), tasks = new Set(), proxyRequests = [], failures = [];
  const identity = await createIdentity();
  const app = createHttpServer(handler);
  const appOrigin = await listen(t, app, sockets);
  const endpoint = createTcpServer({ allowHalfOpen: true, pauseOnConnect: true }, socket => {
    const task = acceptStream(createNodeStreamCarrier(socket), { identity }).then(channel => serveHttp(channel, { origin: appOrigin })).catch(error => failures.push(error.code));
    tasks.add(task); void task.finally(() => tasks.delete(task));
  });
  await listen(t, endpoint, sockets);
  const proxy = createHttpServer((_request, response) => response.writeHead(405).end());
  proxy.on('connect', (request, incoming, head) => {
    proxyRequests.push({ method: request.method, authority: request.url, headers: request.headers });
    if (request.url !== 'application.test:443') { incoming.end('HTTP/1.1 403 Refused\r\n\r\n'); return; }
    const outgoing = connectTcp({ host: '127.0.0.1', port: endpoint.address().port, allowHalfOpen: true });
    sockets.add(outgoing); outgoing.once('close', () => sockets.delete(outgoing)); outgoing.on('error', () => incoming.destroy());
    incoming.on('error', () => outgoing.destroy()); incoming.once('close', () => outgoing.destroy()); outgoing.once('close', () => incoming.destroy());
    outgoing.once('connect', () => {
      incoming.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) outgoing.write(head);
      incoming.pipe(outgoing); outgoing.pipe(incoming);
    });
  });
  const proxyOrigin = await listen(t, proxy, sockets);
  t.after(async () => { for (const socket of sockets) socket.destroy(); await Promise.all(tasks); });
  const connect = async options => connectStream(await connectHttpConnectStream({ proxyOrigin, authority: 'application.test:443', ...options }), { expectedPublicKey: identity.publicKey, ...options });
  return { proxyOrigin, proxyRequests, identity, failures, connect };
}

test('Node CONNECT carries actual pinned Noise and full-duplex binary HTTP without exposing business headers to the proxy', { timeout: 15000 }, async t => {
  const payload = new Uint8Array(4 * 1024 * 1024).map((_, index) => index % 251);
  const expected = createHash('sha256').update(payload).digest('hex');
  let applicationRequests = 0;
  const f = await fixture(t, async (request, response) => {
    applicationRequests++;
    assert.equal(request.headers.authorization, 'Bearer never-on-proxy');
    let size = 0; const hash = createHash('sha256');
    for await (const bytes of request) { size += bytes.length; hash.update(bytes); }
    assert.equal(size, payload.length); assert.equal(hash.digest('hex'), expected);
    response.writeHead(200, { 'content-type': 'application/octet-stream' });
    response.end(payload);
  });
  const fetch = createHttpFetch({ origin: 'https://application.test', connect: f.connect });
  const response = await fetch('https://application.test/private/ticket', { method: 'PUT', headers: { authorization: 'Bearer never-on-proxy' }, body: payload });
  assert.equal(response.status, 200);
  assert.equal(createHash('sha256').update(new Uint8Array(await response.arrayBuffer())).digest('hex'), expected);
  assert.equal(applicationRequests, 1);
  assert.deepEqual(f.proxyRequests, [{ method: 'CONNECT', authority: 'application.test:443', headers: { host: 'application.test:443' } }]);
});

test('CONNECT 200 does not authenticate an endpoint: a wrong Noise pin rejects before business bytes', { timeout: 5000 }, async t => {
  let requests = 0;
  const f = await fixture(t, (_request, response) => { requests++; response.end(); });
  const wrong = await createIdentity();
  await assert.rejects(connectStream(await connectHttpConnectStream({ proxyOrigin: f.proxyOrigin, authority: 'application.test:443' }), { expectedPublicKey: wrong.publicKey }), { code: 'identity_mismatch' });
  assert.equal(f.proxyRequests.length, 1); assert.equal(requests, 0);
});

test('actual proxy response over-read preserves opaque bytes and a non-2xx response never starts the target', { timeout: 5000 }, async t => {
  const sockets = new Set(); let attempts = 0;
  const proxy = createHttpServer();
  proxy.on('connect', (request, socket) => {
    attempts++;
    socket.end(request.url === 'application.test:443'
      ? Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\n\r\n'), Buffer.from([0, 255, 10])])
      : 'HTTP/1.1 407 Authentication Required\r\n\r\n');
  });
  const proxyOrigin = await listen(t, proxy, sockets);
  const stream = await connectHttpConnectStream({ proxyOrigin, authority: 'application.test:443' });
  assert.deepEqual(await stream.read(), new Uint8Array([0, 255, 10]));
  assert.equal(await stream.read(), null); await stream.close();
  await assert.rejects(connectHttpConnectStream({ proxyOrigin, authority: 'unknown.test:443' }), { code: 'authentication_failed' });
  assert.equal(attempts, 2);
});

test('owner cancellation retires a real proxy socket stalled before its response', { timeout: 5000 }, async t => {
  const sockets = new Set(), requested = Promise.withResolvers(), closed = Promise.withResolvers();
  const proxy = createHttpServer();
  proxy.on('connect', (_request, socket) => { socket.once('close', closed.resolve); socket.once('end', () => socket.end()); socket.resume(); requested.resolve(); });
  const proxyOrigin = await listen(t, proxy, sockets);
  const owner = new AbortController();
  const pending = connectHttpConnectStream({ proxyOrigin, authority: 'application.test:443', signal: owner.signal });
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  await requested.promise; owner.abort(); await rejected; await closed.promise;
});

test('HTTPS CONNECT authenticates the proxy before sending CONNECT or Noise', { timeout: 5000 }, async t => {
  const sockets = new Set(); let applicationBytes = 0;
  const [key, cert] = await Promise.all(['private-key.pem', 'certificate.pem'].map(name => readFile(new URL(`../../connectors/test/fixtures/${name}`, import.meta.url))));
  const proxy = createTlsServer({ key, cert }, socket => { socket.on('data', bytes => applicationBytes += bytes.length); });
  proxy.on('tlsClientError', () => {});
  const origin = await listen(t, proxy, sockets);
  await assert.rejects(connectHttpConnectStream({ proxyOrigin: origin.replace('http:', 'https:'), authority: 'application.test:443' }), { code: 'authentication_failed' });
  assert.equal(applicationBytes, 0);
});

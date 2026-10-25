import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createIdentity, connectWebSocket, acceptWebSocket } from '@jokoagent/linkspan-noise';
import { createHttpClient, createHttpFetch } from '../dist/index.js';
import { serveHttp } from '../dist/node.js';

async function fixture(handler) {
  const backend = createServer(handler);
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const backendOrigin = `http://127.0.0.1:${backend.address().port}`;
  const identity = await createIdentity();
  const outer = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ server: outer, maxPayload: 128 * 1024 });
  const tasks = new Set();
  sockets.on('connection', ws => {
    const task = acceptWebSocket(ws, { identity }).then(channel => serveHttp(channel, { origin: backendOrigin })).catch(() => {});
    tasks.add(task);
    task.finally(() => tasks.delete(task));
  });
  await new Promise(resolve => outer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${outer.address().port}`;
  const connect = options => connectWebSocket({ url: origin.replace('http:', 'ws:'), expectedPublicKey: identity.publicKey, ...options });
  return { origin, connect, identity, async close() {
    for (const ws of sockets.clients) ws.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => outer.close(resolve));
    backend.closeAllConnections();
    await new Promise(resolve => backend.close(resolve));
    await Promise.all(tasks);
  } };
}

test('fetch streams binary bodies, secrets and content metadata through a verified endpoint', { timeout: 20_000 }, async () => {
  const bytes = new Uint8Array(4 * 1024 * 1024).fill(137);
  let requests = 0;
  const app = await fixture(async (req, res) => {
    requests++;
    assert.equal(req.headers.authorization, 'Bearer business-secret');
    let size = 0;
    const hash = createHash('sha256');
    for await (const chunk of req) { size += chunk.length; hash.update(chunk); }
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ size, digest: hash.digest('hex') }));
  });
  try {
    const fetch = createHttpFetch(app);
    const response = await fetch(`${app.origin}/v1/blobs/upload/ticket/secret`, { method: 'PUT', headers: { authorization: 'Bearer business-secret' }, body: bytes });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { size: bytes.length, digest: createHash('sha256').update(bytes).digest('hex') });
    assert.equal(requests, 1);
  } finally { await app.close(); }
});

test('client upload and server response can stream at the same time, preserving trailers', { timeout: 15_000 }, async () => {
  let releaseUpload;
  const uploadReleased = new Promise(resolve => { releaseUpload = resolve; });
  const app = await fixture(async (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', trailer: 'x-complete' });
    for await (const chunk of req) { res.write(chunk); }
    res.addTrailers({ 'x-complete': 'yes' });
    res.end();
  });
  try {
    const client = createHttpClient(app);
    async function* body() { yield new TextEncoder().encode('first'); await uploadReleased; yield new TextEncoder().encode('second'); }
    const result = await client({ url: `${app.origin}/peer`, method: 'POST', header: new Headers(), body: body() });
    const iterator = result.body[Symbol.asyncIterator]();
    const first = await iterator.next();
    assert.equal(new TextDecoder().decode(first.value), 'first');
    releaseUpload();
    let text = '';
    for (;;) { const chunk = await iterator.next(); if (chunk.done) break; text += new TextDecoder().decode(chunk.value); }
    assert.equal(text, 'second');
    assert.equal(result.trailer.get('x-complete'), 'yes');
  } finally { releaseUpload(); await app.close(); }
});

test('wrong endpoint keys reject before the first application request; no redirect replay', { timeout: 15_000 }, async () => {
  let requests = 0;
  const app = await fixture((_req, res) => { requests++; res.writeHead(302, { location: 'https://attacker.invalid/' }); res.end(); });
  try {
    const wrong = await createIdentity();
    const fetch = createHttpFetch({ origin: app.origin, connect: options => connectWebSocket({ url: app.origin.replace('http:', 'ws:'), expectedPublicKey: wrong.publicKey, ...options }) });
    await assert.rejects(fetch(`${app.origin}/secret`, { headers: { authorization: 'Bearer never-sent' } }));
    assert.equal(requests, 0);
    const response = await createHttpFetch(app)(`${app.origin}/redirect`);
    assert.equal(response.status, 302);
    await response.text();
    assert.equal(requests, 1);
    await assert.rejects(createHttpFetch(app)('https://attacker.invalid/secret'));
    assert.equal(requests, 1);
  } finally { await app.close(); }
});

test('abort retires a live application stream without reissuing the request', { timeout: 15_000 }, async () => {
  let requests = 0;
  let ended;
  const closed = new Promise(resolve => { ended = resolve; });
  const app = await fixture((req, res) => {
    requests++;
    res.writeHead(200); res.write('ready');
    res.once('close', ended);
  });
  try {
    const controller = new AbortController();
    const response = await createHttpFetch(app)(`${app.origin}/events`, { signal: controller.signal });
    const reader = response.body.getReader();
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'ready');
    controller.abort();
    await assert.rejects(reader.read());
    await closed;
    assert.equal(requests, 1);
  } finally { await app.close(); }
});

test('an absolute request deadline retires the live response and its original local request', { timeout: 15_000 }, async () => {
  let requests = 0;
  let retired;
  const closed = new Promise(resolve => { retired = resolve; });
  const app = await fixture((_req, res) => {
    requests++;
    res.writeHead(200); res.write('ready');
    res.once('close', retired);
  });
  try {
    const result = await createHttpClient(app)({ url: `${app.origin}/events`, method: 'GET', header: new Headers(), deadline: Date.now() + 1_000 });
    const body = result.body[Symbol.asyncIterator]();
    assert.equal(new TextDecoder().decode((await body.next()).value), 'ready');
    await assert.rejects(body.next(), { code: 'deadline_exceeded' });
    await closed;
    assert.equal(requests, 1);
  } finally { await app.close(); }
});

test('an early completed response cancels a stalled upload producer without waiting for more input', { timeout: 15_000 }, async () => {
  let cancelled = false;
  const app = await fixture((req, res) => {
    req.once('data', () => { res.writeHead(204); res.end(); });
  });
  try {
    let first = true;
    const body = new ReadableStream({
      pull(controller) { if (first) { first = false; controller.enqueue(new Uint8Array([7])); } },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const response = await createHttpFetch(app)(`${app.origin}/early-response`, { method: 'POST', body });
    assert.equal(response.status, 204);
    assert.equal(response.body, null);
    assert.equal(cancelled, true);
  } finally { await app.close(); }
});

test('malformed bodyless responses cancel the upload and release owner listeners', async () => {
  const encoder = new TextEncoder();
  const metadata = encoder.encode(JSON.stringify({ status: 204, headers: [] }));
  const head = new Uint8Array(metadata.length + 1); head[0] = 3; head.set(metadata, 1);
  const frames = [head, new Uint8Array([1, 99])];
  let settleClosed;
  let aborted;
  let cancelled = false;
  const channel = {
    closed: new Promise(resolve => { settleClosed = resolve; }),
    send: async () => {}, receive: async () => frames.shift() ?? null,
    close: async () => settleClosed({}),
    abort(reason) { aborted = reason; settleClosed({ error: reason }); },
  };
  const owner = new AbortController();
  let listeners = 0;
  const add = owner.signal.addEventListener.bind(owner.signal);
  const remove = owner.signal.removeEventListener.bind(owner.signal);
  owner.signal.addEventListener = (...args) => { listeners++; return add(...args); };
  owner.signal.removeEventListener = (...args) => { listeners--; return remove(...args); };
  const body = new ReadableStream({ cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const fetcher = createHttpFetch({ origin: 'https://pinned.invalid', connect: async () => channel });
  await assert.rejects(fetcher('https://pinned.invalid/resource', { method: 'POST', body, signal: owner.signal }), { code: 'protocol_error' });
  assert.equal(cancelled, true);
  assert.equal(listeners, 0);
  assert.equal(aborted.code, 'protocol_error');
});

test('a connection returned after its request deadline is aborted before business bytes are sent', async () => {
  let resolveConnection;
  let aborted;
  let sends = 0;
  const client = createHttpClient({ origin: 'https://pinned.invalid', connect: () => new Promise(resolve => { resolveConnection = resolve; }) });
  await assert.rejects(client({ url: 'https://pinned.invalid/resource', method: 'GET', header: new Headers(), deadline: Date.now() + 20 }), { code: 'deadline_exceeded' });
  resolveConnection({ abort(reason) { aborted = reason; }, send: async () => { sends++; } });
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(aborted.code, 'deadline_exceeded');
  assert.equal(sends, 0);
});

test('an invalid HTTP request retires immediately even when its peer never accepts another write', { timeout: 1_000 }, async () => {
  let aborted;
  let writes = 0;
  let resolveClosed;
  const channel = {
    closed: new Promise(resolve => { resolveClosed = resolve; }),
    receive: async () => new Uint8Array([0, ...new TextEncoder().encode(JSON.stringify({ version: 1, method: 'GET', target: '//attacker.invalid/', headers: [] }))]),
    send() { writes++; return new Promise(() => {}); },
    close: async () => {},
    abort(error) { aborted = error; resolveClosed({ error }); },
  };
  await assert.rejects(serveHttp(channel, { origin: 'http://127.0.0.1:1' }), { code: 'protocol_error' });
  assert.equal(aborted.code, 'protocol_error');
  assert.equal(writes, 0);
});

test('a refused local HTTP request releases host authorization without waiting on peer flow control', { timeout: 1_000 }, async () => {
  const unused = createServer();
  await new Promise(resolve => unused.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${unused.address().port}`;
  await new Promise(resolve => unused.close(resolve));
  const encode = (kind, value) => new Uint8Array([kind, ...new TextEncoder().encode(JSON.stringify(value))]);
  const records = [encode(0, { version: 1, method: 'GET', target: '/', headers: [] }), encode(2, { headers: [] })];
  let aborted;
  let released = 0;
  let writes = 0;
  let resolveClosed;
  const channel = {
    closed: new Promise(resolve => { resolveClosed = resolve; }),
    receive: async () => records.shift() ?? null,
    send() { writes++; return new Promise(() => {}); },
    close: async () => {},
    abort(error) { aborted = error; resolveClosed({ error }); },
  };
  await assert.rejects(serveHttp(channel, { origin, authorize: () => () => { released++; } }));
  assert.equal(aborted.code, 'protocol_error');
  assert.equal(released, 1);
  assert.equal(writes, 0);
});

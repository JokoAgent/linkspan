import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { once } from 'node:events';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createIdentity, acceptWebSocket, connectWebSocket } from '../packages/noise/dist/index.js';
import { createHttpClient, createHttpFetch } from '../packages/http/dist/index.js';
import { serveHttp } from '../packages/http/dist/node.js';
import { prepareCloudflared, startQuickTunnel } from '../packages/cloudflare/dist/index.js';

const requireNoise = createRequire(new URL('../packages/noise/package.json', import.meta.url));
const { WebSocketServer, WebSocket: WsClient } = requireNoise('ws');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bytesArgument = process.argv.find(value => value.startsWith('--bytes='));
const transferBytes = bytesArgument ? Number(bytesArgument.slice('--bytes='.length)) : 256 * 1024 * 1024;
const useDoh = process.argv.includes('--dns-over-https');
const originCaPool = process.env.LINKSPAN_REFERENCE_TLS_CERTIFICATE;
const originKeyPath = process.env.LINKSPAN_REFERENCE_TLS_KEY;
const originServerName = process.env.LINKSPAN_REFERENCE_TLS_SERVER_NAME;
if (!originCaPool || !originKeyPath || !originServerName) throw new Error('Set LINKSPAN_REFERENCE_TLS_CERTIFICATE, LINKSPAN_REFERENCE_TLS_KEY and LINKSPAN_REFERENCE_TLS_SERVER_NAME for the host-approved HTTPS origin.');
if (!Number.isSafeInteger(transferBytes) || transferBytes < 1 || transferBytes > 256 * 1024 * 1024) throw new Error('The reference transfer size must be between one byte and 256 MiB.');
const evidence = join(root, '.runtime', 'research', 'public-reference', new Date().toISOString().replace(/[:.]/gu, '-') + '-' + randomUUID());
await mkdir(evidence, { recursive: true });
const report = { version: 1, startedAt: new Date().toISOString(), status: 'running', stage: 'preparation', transferBytes, checks: [], limitations: ['Synthetic library reference chain; this is not Joko product or real-device acceptance.', 'Quick Tunnel hostname is temporary. The observed traffic and duration do not establish an availability guarantee.'] };
report.artifactInputs = Object.fromEntries(await Promise.all(['core/dist/index.js', 'noise/dist/index.js', 'http/dist/index.js', 'http/dist/node.js', 'http/dist/wire.js', 'http/dist/fetch-body.js', 'cloudflare/dist/index.js', 'cloudflare/dist/artifacts.js'].map(async path => [path, createHash('sha256').update(await readFile(join(root, 'packages', path))).digest('hex')])));
const authorization = `Bearer ${randomBytes(32).toString('base64url')}`;
const privateCredential = randomBytes(96);
const block = Buffer.alloc(64 * 1024);
for (let index = 0; index < block.length; index++) block[index] = (index * 31 + 17) % 256;
const expectedHasher = createHash('sha256');
for (let offset = 0; offset < transferBytes; offset += block.length) expectedHasher.update(block.subarray(0, Math.min(block.length, transferBytes - offset)));
const expectedDigest = expectedHasher.digest('hex');
const blobPath = join(evidence, 'synthetic-blob.bin');
let backend, outer, sockets, tunnel;
let requests = 0, plaintextRequests = 0, carrierBytes = 0, carrierLeak = false, cancelledAtServer = false;
const channels = new Set(), tasks = new Set();
const lifetime = new AbortController();
const deadline = setTimeout(() => lifetime.abort(new Error('The bounded public reference run expired.')), 12 * 60_000);

async function listen(server, secure = false) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `${secure ? 'https' : 'http'}://127.0.0.1:${server.address().port}`;
}
async function check(name, work) {
  report.stage = name; await save(); const started = Date.now();
  await work(); report.checks.push({ name, status: 'passed', elapsedMs: Date.now() - started });
  await save(); console.log(JSON.stringify({ check: name, status: 'passed', elapsedMs: Date.now() - started }));
}
async function save() { await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2) + '\n'); }
async function bounded(predicate, label, timeoutMs = 5_000) {
  const until = Date.now() + timeoutMs;
  while (!predicate()) { if (Date.now() >= until) throw new Error(label); await new Promise(resolve => setTimeout(resolve, 25)); }
}
function safeError(error) { return { name: error?.name ?? 'Error', code: typeof error?.code === 'string' ? error.code : typeof error?.cause?.code === 'string' ? error.cause.code : 'reference_failed', message: typeof error?.message === 'string' ? error.message.slice(0, 400) : 'The reference operation failed.' }; }

try {
  backend = createServer((request, response) => {
    void (async () => {
      requests++;
      if (request.headers.authorization !== authorization) { response.writeHead(401); response.end(); return; }
      response.setHeader('cache-control', 'no-store');
      if (request.method === 'GET' && request.url === '/api/catalog') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ revision: 7, nodes: [{ id: 'reference-node', connected: true }] }));
      } else if (request.method === 'POST' && request.url === '/v1/credentials/purpose-bound') {
        const chunks = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 1024) throw new Error('Reference credential size exceeded.'); chunks.push(chunk); }
        assert.deepEqual(Buffer.concat(chunks), privateCredential);
        response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify({ accepted: true, purpose: 'reference-only' }));
      } else if (request.method === 'PUT' && request.url === '/v1/blobs/reference-owned') {
        const hash = createHash('sha256'); let size = 0;
        const verifier = new Transform({ transform(chunk, _encoding, callback) { size += chunk.length; if (size > transferBytes) { callback(new Error('Reference upload exceeded its budget.')); return; } hash.update(chunk); callback(null, chunk); } });
        await pipeline(request, verifier, createWriteStream(blobPath, { flags: 'wx', mode: 0o600 }));
        assert.equal(size, transferBytes); assert.equal(hash.digest('hex'), expectedDigest);
        response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify({ id: 'reference-owned', bytes: size, sha256: expectedDigest }));
      } else if (request.method === 'GET' && request.url === '/v1/blobs/reference-owned') {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(transferBytes) });
        await pipeline(createReadStream(blobPath, { highWaterMark: 64 * 1024 }), response);
      } else if (request.method === 'GET' && request.url === '/events/stream') {
        response.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (let sequence = 0; sequence < 20; sequence++) { response.write(JSON.stringify({ sequence }) + '\n'); await new Promise(resolve => setTimeout(resolve, 500)); }
        response.end();
      } else if (request.method === 'POST' && request.url === '/peer/duplex') {
        response.writeHead(200, { 'content-type': 'application/x-ndjson', trailer: 'x-peer-complete' });
        response.write(JSON.stringify({ ready: true }) + '\n');
        let size = 0;
        for await (const chunk of request) { size += chunk.length; response.write(JSON.stringify({ received: size }) + '\n'); }
        response.addTrailers({ 'x-peer-complete': 'yes' }); response.end();
      } else if (request.method === 'GET' && request.url === '/events/cancel') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        const interval = setInterval(() => response.write(Buffer.alloc(1024, 42)), 50);
        response.once('close', () => { cancelledAtServer = true; clearInterval(interval); });
      } else { response.writeHead(404); response.end(); }
    })().catch(error => { response.destroy(error); });
  });
  const backendOrigin = await listen(backend);
  const identity = await createIdentity();
  outer = createHttpsServer({ cert: await readFile(originCaPool), key: await readFile(originKeyPath) }, (_request, response) => { plaintextRequests++; response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); });
  sockets = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  outer.on('upgrade', (request, socket, head) => {
    if (request.method !== 'GET' || request.url !== '/linkspan' || request.headers.authorization !== undefined) { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, ws => sockets.emit('connection', ws));
  });
  sockets.on('connection', ws => {
    ws.on('message', value => {
      const bytes = Buffer.from(value); carrierBytes += bytes.length;
      if (bytes.includes(Buffer.from(authorization)) || bytes.includes(privateCredential)) carrierLeak = true;
    });
    const task = acceptWebSocket(ws, { identity, signal: lifetime.signal }).then(async channel => {
      channels.add(channel);
      try { await serveHttp(channel, { origin: backendOrigin, signal: lifetime.signal }); }
      finally { channels.delete(channel); }
    }).catch(() => undefined);
    tasks.add(task); void task.finally(() => tasks.delete(task));
  });
  const localOrigin = await listen(outer, true);
  report.stage = 'prepare-pinned-helper'; await save();
  const helper = await prepareCloudflared({ directory: join(root, '.runtime', 'helpers'), signal: lifetime.signal });
  report.helper = { version: helper.version, target: helper.target, sha256: helper.sha256, bytes: helper.bytes };
  report.stage = 'start-public-carrier'; await save();
  tunnel = await startQuickTunnel({ executable: helper.executable, requestId: `reference-${randomUUID()}`, localOrigin, originCaPool, originServerName, signal: lifetime.signal,
    onSpawn: resource => { report.resource = resource; writeFileSync(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2) + '\n'); } });
  report.publicOrigin = tunnel.publicOrigin;
  let lookup;
  if (useDoh) {
    report.stage = 'explicit-dns-over-https';
    const publicHost = new URL(tunnel.publicOrigin).hostname;
    const resolver = 'https://cloudflare-dns.com/dns-query';
    let address;
    const dnsEnd = Date.now() + 60_000;
    const dnsObservations = [];
    while (address === undefined) {
      const answer = await fetch(`${resolver}?name=${encodeURIComponent(publicHost)}&type=A`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)]) });
      assert.equal(answer.status, 200);
      const result = await answer.json();
      dnsObservations.push(result.Status);
      if (result.Status === 0) address = result.Answer?.find(record => record.type === 1 && isIP(record.data) === 4)?.data;
      if (address === undefined) {
        if (Date.now() >= dnsEnd || ![0, 2, 3].includes(result.Status)) throw new Error(`The temporary hostname did not resolve within its warmup bound (DNS status ${result.Status}).`);
        await new Promise(resolve => setTimeout(resolve, 1_000));
      }
    }
    lookup = (hostname, options, callback) => {
      if (hostname !== publicHost) { callback(new Error('The reference lookup target changed.')); return; }
      if (options?.all) callback(null, [{ address, family: 4 }]); else callback(null, address, 4);
    };
    report.resolution = { mode: 'explicit-dns-over-https', resolver, address, dnsObservations, tlsServerNamePreserved: true, certificateVerification: true };
    report.limitations.push('System DNS refused the temporary hostname in an earlier recorded run. This run explicitly selected DNS over HTTPS; ordinary system-DNS reachability is not claimed.');
  } else report.resolution = { mode: 'system' };
  const socketOptions = lookup === undefined ? {} : { createSocket: address => new WsClient(address, { lookup, handshakeTimeout: 10_000 }) };
  const connect = options => connectWebSocket({ url: tunnel.publicOrigin.replace('https:', 'wss:') + '/linkspan', expectedPublicKey: identity.publicKey, ...socketOptions, ...options });
  const secureFetch = createHttpFetch({ origin: tunnel.publicOrigin, connect });
  const authHeaders = { authorization };
  async function publicStatus(path) {
    if (lookup === undefined) {
      const response = await fetch(tunnel.publicOrigin + path, { redirect: 'error', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]) });
      const status = response.status; await response.body?.cancel(); return status;
    }
    return new Promise((resolve, reject) => {
      const request = httpsRequest(tunnel.publicOrigin + path, { method: 'GET', lookup, rejectUnauthorized: true, agent: false, signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(20_000)]) }, response => { response.resume(); resolve(response.statusCode); });
      request.once('error', reject); request.end();
    });
  }

  await check('public-carrier-readiness', async () => {
    const end = Date.now() + 60_000;
    const observations = [];
    for (;;) {
      const status = await publicStatus('/reference-readiness'); observations.push(status);
      if (status === 404) break;
      if (Date.now() >= end || ![429, 502, 503, 530].includes(status)) throw new Error(`The temporary public carrier did not become ready (HTTP ${status}).`);
      await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    report.readiness = { observations };
  });

  await check('public-plaintext-sensitive-routes-rejected', async () => {
    const before = requests;
    for (const path of ['/api/catalog', '/v1/blobs/reference-owned', '/v1/credentials/purpose-bound']) {
      assert.equal(await publicStatus(path), 404);
    }
    assert.equal(requests, before);
  });
  await check('pinned-api-and-purpose-bound-credential', async () => {
    const response = await secureFetch(tunnel.publicOrigin + '/api/catalog', { headers: authHeaders, signal: lifetime.signal });
    assert.equal(response.status, 200); assert.equal((await response.json()).revision, 7);
    const credential = await secureFetch(tunnel.publicOrigin + '/v1/credentials/purpose-bound', { method: 'POST', headers: authHeaders, body: privateCredential, signal: lifetime.signal });
    assert.equal(credential.status, 201); assert.equal((await credential.json()).accepted, true);
  });
  await check('wrong-pin-zero-business-dispatch', async () => {
    const wrong = await createIdentity(), before = requests;
    const wrongFetch = createHttpFetch({ origin: tunnel.publicOrigin, connect: options => connectWebSocket({ url: tunnel.publicOrigin.replace('https:', 'wss:') + '/linkspan', expectedPublicKey: wrong.publicKey, ...socketOptions, ...options }) });
    await assert.rejects(wrongFetch(tunnel.publicOrigin + '/api/catalog', { headers: authHeaders, signal: lifetime.signal }));
    assert.equal(requests, before);
  });
  await check('sustained-incremental-stream-ten-seconds', async () => {
    const started = Date.now();
    const response = await secureFetch(tunnel.publicOrigin + '/events/stream', { headers: authHeaders, signal: lifetime.signal });
    const reader = response.body.getReader(); let data = '', firstAt;
    for (;;) { const next = await reader.read(); if (next.done) break; firstAt ??= Date.now(); data += new TextDecoder().decode(next.value); }
    reader.releaseLock();
    const rows = data.trim().split('\n').map(row => JSON.parse(row));
    assert.equal(rows.length, 20); assert.equal(rows[19].sequence, 19);
    assert.ok(firstAt - started < 8_000, 'Stream delivery was buffered until completion.');
    assert.ok(Date.now() - firstAt > 5_000, 'The response was not observed incrementally.');
  });
  await check('simultaneous-peer-upload-response-and-trailers', async () => {
    let release; const released = new Promise(resolve => { release = resolve; });
    async function* upload() { yield block; await released; yield block.subarray(0, 16384); }
    try {
      const result = await createHttpClient({ origin: tunnel.publicOrigin, connect })({ url: tunnel.publicOrigin + '/peer/duplex', method: 'POST', header: new Headers(authHeaders), body: upload(), signal: lifetime.signal });
      const iterator = result.body[Symbol.asyncIterator](); const first = await iterator.next();
      assert.ok(!first.done); assert.ok(new TextDecoder().decode(first.value).includes('ready'));
      release(); let data = '';
      for (;;) { const next = await iterator.next(); if (next.done) break; data += new TextDecoder().decode(next.value); }
      assert.ok(data.includes(String(block.length + 16384))); assert.equal(result.trailer.get('x-peer-complete'), 'yes');
    } finally { release(); }
  });
  await check('binary-upload-verified-receipt', async () => {
    let offset = 0;
    const body = new ReadableStream({ pull(controller) { if (offset === transferBytes) { controller.close(); return; } const chunk = block.subarray(0, Math.min(block.length, transferBytes - offset)); offset += chunk.length; controller.enqueue(chunk); } }, { highWaterMark: 0 });
    const response = await secureFetch(tunnel.publicOrigin + '/v1/blobs/reference-owned', { method: 'PUT', headers: { ...authHeaders, 'content-type': 'application/octet-stream', 'content-length': String(transferBytes) }, body, duplex: 'half', signal: lifetime.signal });
    assert.equal(response.status, 201); assert.deepEqual(await response.json(), { id: 'reference-owned', bytes: transferBytes, sha256: expectedDigest });
  });
  await check('binary-download-incremental-digest', async () => {
    const response = await secureFetch(tunnel.publicOrigin + '/v1/blobs/reference-owned', { headers: authHeaders, signal: lifetime.signal });
    assert.equal(response.headers.get('content-length'), String(transferBytes));
    const reader = response.body.getReader(), hash = createHash('sha256'); let size = 0;
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; assert.ok(size <= transferBytes); hash.update(next.value); }
    reader.releaseLock(); assert.equal(size, transferBytes); assert.equal(hash.digest('hex'), expectedDigest);
  });
  await check('cancel-retires-original-backend-stream', async () => {
    const cancellation = new AbortController();
    const response = await secureFetch(tunnel.publicOrigin + '/events/cancel', { headers: authHeaders, signal: AbortSignal.any([lifetime.signal, cancellation.signal]) });
    const reader = response.body.getReader(); await reader.read(); cancellation.abort();
    await assert.rejects(reader.read()); reader.releaseLock();
    await bounded(() => cancelledAtServer, 'The cancelled stream remained active in the backend.');
  });
  await check('carrier-secret-isolation-and-helper-cleanup', async () => {
    assert.ok(carrierBytes > transferBytes); assert.equal(carrierLeak, false);
    const pid = tunnel.processId; await tunnel.close();
    const exit = await tunnel.closed; assert.equal(exit.reason, 'stopped');
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    report.resourceExit = exit; tunnel = undefined;
  });
  report.status = 'passed'; report.stage = 'complete';
} catch (error) {
  report.status = 'failed'; report.error = safeError(error);
  console.log(JSON.stringify({ status: 'failed', stage: report.stage, error: report.error }));
  process.exitCode = 1;
} finally {
  lifetime.abort(); clearTimeout(deadline);
  if (tunnel) {
    try { await tunnel.close(); report.resourceExit = await tunnel.closed; }
    catch (error) { report.cleanupError = safeError(error); report.status = 'failed'; process.exitCode = 1; }
  }
  for (const channel of channels) channel.abort();
  for (const ws of sockets?.clients ?? []) ws.terminate();
  if (sockets) await new Promise(resolve => sockets.close(resolve));
  if (outer) { outer.closeAllConnections(); await new Promise(resolve => outer.close(resolve)); }
  if (backend) { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
  await Promise.all(tasks);
  report.completedAt = new Date().toISOString(); report.requests = requests; report.plaintextRequests = plaintextRequests;
  report.carrierBytes = carrierBytes; report.carrierLeak = carrierLeak;
  await save(); console.log(JSON.stringify({ status: report.status, evidence: join(evidence, 'receipt.json'), transferBytes }));
}

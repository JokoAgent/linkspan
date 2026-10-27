import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import net from 'node:net';
import { start } from '../dist/index.js';
import { caCert, budget, origin } from '../../connectors/test/fixtures/origin.mjs';

function trustFixture(t) {
  const request = https.request;
  t.mock.method(https, 'request', function (options, callback) { return request.call(this, { ...options, ca: caCert, servername: 'carrier.test' }, callback); });
}

for (const phase of ['request', 'retry']) test(`localtunnel cancellation stops its real HTTPS bootstrap ${phase}`, { timeout: 5000 }, async t => {
  trustFixture(t);
  let requests = 0, reached; const requested = new Promise(resolve => { reached = resolve; });
  const sockets = new Set();
  const provider = await origin(t, (_request, response) => {
    requests++; reached();
    if (phase === 'retry') { response.statusCode = 503; response.end('unavailable'); }
  });
  provider.server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const app = await origin(t), controller = new AbortController();
  const operation = start({ provider: 'localtunnel', host: provider.options.localOrigin, budget }, { ...app.options, signal: controller.signal });
  const outcome = assert.rejects(operation, { code: 'outcome_unknown' });
  await requested;
  // Let the real SDK process the rejected response and schedule its retry.
  if (phase === 'retry') await new Promise(resolve => setTimeout(resolve, 50));
  controller.abort(); await outcome;
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(requests, 1); assert.equal(sockets.size, 0);
});

test('localtunnel startup deadline cancels an unanswered HTTPS registration', { timeout: 5000 }, async t => {
  trustFixture(t);
  const sockets = new Set();
  const provider = await origin(t, () => {});
  provider.server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  const app = await origin(t);
  await assert.rejects(start({ provider: 'localtunnel', host: provider.options.localOrigin, budget }, { ...app.options, startupTimeoutMs: 1000 }), { code: 'outcome_unknown' });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(sockets.size, 0);
});

test('localtunnel closes every owned socket even before the provider TCP connection completes', { timeout: 5000 }, async t => {
  trustFixture(t);
  const pending = [], connect = net.connect;
  t.mock.method(net, 'connect', function (...args) {
    if (args[0]?.port !== 24681) return connect.apply(this, args);
    const socket = new net.Socket(); pending.push(socket); return socket;
  });
  const provider = await origin(t, (_request, response) => response.end(JSON.stringify({ id: 'owned', url: 'https://assigned.example', ip: '127.0.0.1', port: 24681, max_conn_count: 2 })));
  const app = await origin(t), controller = new AbortController();
  const carrier = await start({ provider: 'localtunnel', host: provider.options.localOrigin, budget }, { ...app.options, signal: controller.signal });
  t.after(() => carrier.close());
  assert.equal(pending.length, 2); assert.equal(pending.some(socket => socket.destroyed), false);
  controller.abort(); await carrier.closed;
  assert.equal(pending.every(socket => socket.destroyed), true);
});

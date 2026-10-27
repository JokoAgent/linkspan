import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import ssh2 from 'ssh2';
import { start } from '../dist/index.js';
import { key, budget, origin } from '../../connectors/test/fixtures/origin.mjs';

for (const phase of ['tcpip-forward', 'exec']) test(`cancelling Pinggy SSH during ${phase} closes the real publisher session`, { timeout: 10000 }, async t => {
  let reached; const pending = new Promise(resolve => { reached = resolve; });
  let disconnected; const closed = new Promise(resolve => { disconnected = resolve; });
  const clients = new Set();
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.once('close', () => { clients.delete(client); disconnected(); });
    client.on('authentication', context => context.accept());
    client.on('ready', () => {
      client.on('request', (accept, _reject, name) => { if (name === 'tcpip-forward') { if (phase === name) reached(); else accept(23456); } });
      client.on('session', accept => accept().on('exec', accept => { accept(); reached(); }));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of clients) client.destroy(); await new Promise(resolve => server.close(resolve)); });
  // Keep the actual SSH protocol and pin verification, redirecting only the
  // fixed supplier port to this test's private loopback service.
  const connect = ssh2.Client.prototype.connect;
  t.mock.method(ssh2.Client.prototype, 'connect', function (options) { return connect.call(this, { ...options, host: '127.0.0.1', port: server.address().port }); });
  const app = await origin(t), controller = new AbortController();
  const serverHostKeySha256 = `SHA256:${createHash('sha256').update(ssh2.utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/u, '')}`;
  const operation = start({ provider: 'pinggy', runtime: 'ssh', mode: 'http', serverAddress: '127.0.0.1', serverHostKeySha256, budget }, { ...app.options, signal: controller.signal });
  const result = assert.rejects(operation, { code: 'outcome_unknown' });
  await pending; controller.abort(); await result; await closed;
  assert.equal(clients.size, 0);
});

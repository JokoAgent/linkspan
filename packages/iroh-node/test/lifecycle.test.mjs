import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { configureIrohRuntime, createIrohRuntime } from '../dist/index.js';

async function fixture(t, close) {
  const directory = await mkdtemp(join(tmpdir(), 'linkspan-iroh-close-'));
  const native = join(directory, 'iroh.node'), sdkUrl = pathToFileURL(join(directory, 'controlled.cjs')).href;
  const bytes = Buffer.from('controlled native boundary');
  await writeFile(native, bytes);
  await writeFile(join(directory, 'iroh-runtime.json'), JSON.stringify({ target: `${process.platform}-${process.arch}`, version: '1.2.0',
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }));
  const key = Symbol.for('linkspan.test.iroh-sdk');
  const endpoint = { id: () => ({ toString: () => 'a'.repeat(64) }), addr: () => ({}), close,
    acceptNext: () => assert.fail('A retiring listener must not accept another peer.') };
  globalThis[key] = {
    Endpoint: { builder: () => ({ applyMinimal() {}, alpns() {}, relayMode() {}, bind: async () => endpoint }) },
    RelayMode: { disabled: () => ({}) }, EndpointTicket: { fromAddr: () => ({ toString: () => 'controlled-ticket' }) }
  };
  const hooks = registerHooks({
    resolve(specifier, context, next) { return specifier === native ? { url: sdkUrl, shortCircuit: true } : next(specifier, context); },
    load(url, context, next) { return url === sdkUrl ? { format: 'commonjs', source: 'module.exports = globalThis[Symbol.for("linkspan.test.iroh-sdk")];', shortCircuit: true } : next(url, context); }
  });
  t.after(async () => { hooks.deregister(); delete globalThis[key]; await rm(directory, { recursive: true, force: true }); });
  configureIrohRuntime(directory);
  return createIrohRuntime();
}

test('iroh abort and concurrent closes wait for the same native retirement', { timeout: 5000 }, async t => {
  const gate = Promise.withResolvers(); let closes = 0, retired = false;
  t.after(() => gate.resolve());
  const runtime = await fixture(t, () => { closes++; return gate.promise; });
  const controller = new AbortController();
  const listener = await runtime.listen({ relayUrls: [], signal: controller.signal });
  controller.abort();
  const first = listener.close(), second = listener.close();
  assert.equal(first, second);
  void first.then(() => { retired = true; });
  await setImmediate();
  assert.equal(closes, 1); assert.equal(retired, false);
  assert.equal(await listener.accept(), null);
  gate.resolve(); await first;
  await listener.close(); assert.equal(closes, 1); assert.equal(retired, true);
});

test('iroh failed abort cleanup remains observable and retries the original endpoint', { timeout: 5000 }, async t => {
  const gate = Promise.withResolvers(); let closes = 0;
  t.after(() => gate.resolve());
  const runtime = await fixture(t, () => ++closes === 1 ? gate.promise : Promise.resolve());
  const controller = new AbortController();
  const listener = await runtime.listen({ relayUrls: [], signal: controller.signal });
  controller.abort();
  const pending = listener.close();
  const rejected = assert.rejects(pending, /native cleanup failed/);
  gate.reject(new Error('native cleanup failed')); await rejected;
  assert.equal(closes, 1); assert.equal(await listener.accept(), null);
  await listener.close(); await listener.close(); assert.equal(closes, 2);
});

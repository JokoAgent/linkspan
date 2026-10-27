import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setImmediate } from 'node:timers/promises';
import { origin, budget } from '../../connectors/test/fixtures/origin.mjs';
import { reconcileConnectorResource } from '@jokoagent/linkspan-connector-runtime/runtime';

test('Pinggy adapter and UDP mapping retain the original tunnel across failed cleanup', { timeout: 15000 }, async t => {
  const sdkDirectory = join(tmpdir(), 'linkspan-pinggy-controlled'), sdkUrl = pathToFileURL(join(sdkDirectory, 'dist/index.js')).href;
  const prepareUrl = new URL('../dist/prepare.js', import.meta.url).href;
  let selected;
  const key = Symbol.for('linkspan.test.pinggy-sdk');
  globalThis[key] = { setDebugLogging(value) { assert.equal(value, false); }, async createTunnel() { selected.creates++; return selected.tunnel; } };
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (specifier === sdkUrl) return { url: sdkUrl, shortCircuit: true };
      return next(specifier, context);
    },
    load(url, context, next) {
      // Integrity has separate prepared-artifact coverage. Inject only the SDK
      // boundary here; the provider, bridge and lifecycle are the actual code.
      if (url === prepareUrl) return { format: 'module', source: 'export async function verifyPinggySdk() {} export async function preparePinggySdk() {}', shortCircuit: true };
      if (url === sdkUrl) return { format: 'module', source: 'export const pinggy = globalThis[Symbol.for("linkspan.test.pinggy-sdk")];', shortCircuit: true };
      return next(url, context);
    }
  });
  t.after(() => { hooks.deregister(); delete globalThis[key]; });
  const { start } = await import('../dist/index.js');
  const { startDatagramMapping } = await import('../../connectors/dist/datagram.js');
  for (const mode of ['http', 'tls', 'tcp', 'tlstcp', 'udp']) await t.test(mode, async t => {
    const app = await origin(t), gate = Promise.withResolvers(), stopping = Promise.withResolvers();
    let disconnected, stops = 0;
    selected = { creates: 0, tunnel: { async start() { return [`${mode === 'http' ? 'https' : mode === 'tlstcp' ? 'tcp' : mode}://public.example:4443`]; },
      stop() { stops++; stopping.resolve(); if (stops === 1) return gate.promise; disconnected?.(); return Promise.resolve(); },
      setWorkerErrorCallback() {}, setTunnelDisconnectedCallback(value) { disconnected = value; } } };
    const config = { provider: 'pinggy', runtime: 'sdk', sdkDirectory, budget: { ...budget, paidEnabled: true },
      ...(mode === 'udp' ? {} : { mode, publicOrigin: 'https://public.example:4443' }), ...(mode === 'tlstcp' ? { tlstcpEndpoint: 'tcp' } : {}) };
    const receipts = [];
    const carrier = mode === 'udp' ? await startDatagramMapping(config, { requestId: `original-${mode}`, localTarget: { address: '127.0.0.1', port: 4318, ownerId: 'original-capture' }, onResource: value => { receipts.push(value); } })
      : await start(config, { ...app.options, requestId: `original-${mode}`, onResource: value => { receipts.push(value); } });
    t.after(async () => { gate.resolve(); await carrier.close(); });
    const first = carrier.close(); assert.equal(carrier.close(), first);
    const rejected = assert.rejects(first, error => error.code === 'outcome_unknown' && error.outcome === 'unknown' && !String(error).includes('private-provider-error'));
    await stopping.promise; await setImmediate();
    assert.equal(stops, 1); gate.reject(new Error('private-provider-error')); await rejected;
    assert.equal(stops, 1); assert.equal(selected.creates, 1);
    const owned = carrier.resource;
    if (mode === 'udp') await carrier.close();
    else assert.deepEqual(await reconcileConnectorResource(config, owned, { requestId: owned.requestId }), { state: 'retired' });
    await carrier.closed; await carrier.close();
    assert.equal(stops, 2); assert.equal(selected.creates, 1); assert.equal(carrier.resource, owned);
    assert.ok(receipts.every(value => value.id === owned.id && value.requestId === owned.requestId));
  });
});

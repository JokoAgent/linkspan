import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import { origin, budget } from '../../connectors/test/fixtures/origin.mjs';

for (const phase of ['import', 'connect', 'listen']) test(`ngrok cancellation during ${phase} retires only its original SDK objects`, { timeout: 5000 }, async t => {
  const app = await origin(t), controller = new AbortController();
  const imported = Promise.withResolvers(), load = Promise.withResolvers(), connecting = Promise.withResolvers(), listening = Promise.withResolvers();
  const connectStarted = Promise.withResolvers(), listenStarted = Promise.withResolvers(), sessionClosed = Promise.withResolvers(), listenerClosed = Promise.withResolvers();
  let connects = 0, listens = 0, sessionCloses = 0, listenerCloses = 0;
  const listener = { url: () => 'https://owned.example', id: () => 'original-listener', join: () => new Promise(() => {}),
    async close() { listenerCloses++; listenerClosed.resolve(); } };
  const builder = { scheme() { return this; }, metadata(value) { assert.equal(value, `linkspan:${app.options.requestId}`); return this; },
    listenAndForward(address) { assert.match(address, /^http:\/\/127\.0\.0\.1:/u); listens++; listenStarted.resolve(); return listening.promise; } };
  const session = { httpEndpoint: () => builder, async close() { sessionCloses++; sessionClosed.resolve(); } };
  const key = `linkspan.test.ngrok.${randomUUID()}`;
  globalThis[Symbol.for(key)] = { imported, load, SessionBuilder: class {
    authtoken() { return this; } clientInfo() { return this; }
    connect() { connects++; connectStarted.resolve(); return connecting.promise; }
  } };
  const url = `data:text/javascript,${encodeURIComponent(`const f = globalThis[Symbol.for(${JSON.stringify(key)})]; f.imported.resolve(); await f.load.promise; export const SessionBuilder = f.SessionBuilder;`)}`;
  const hooks = registerHooks({ resolve(specifier, context, next) { return specifier === '@ngrok/ngrok' ? { url, shortCircuit: true } : next(specifier, context); } });
  t.after(async () => { load.resolve(); connecting.resolve(session); listening.resolve(listener); await setImmediate(); hooks.deregister(); delete globalThis[Symbol.for(key)]; });
  const { start } = await import(`../dist/index.js?cancel=${phase}`);
  const operation = start({ provider: 'ngrok', mode: 'http', authtoken: 'publisher-private-token', budget }, { ...app.options, signal: controller.signal });
  const rejected = assert.rejects(operation, error => error.code === 'outcome_unknown' && error.outcome === 'unknown' && !String(error).includes('publisher-private-token'));
  await imported.promise;
  if (phase !== 'import') { load.resolve(); await connectStarted.promise; }
  if (phase === 'listen') { connecting.resolve(session); await listenStarted.promise; }
  controller.abort(); await rejected;
  if (phase === 'import') {
    load.resolve(); await setImmediate(); assert.equal(connects, 0); assert.equal(listens, 0);
  } else if (phase === 'connect') {
    connecting.resolve(session); await sessionClosed.promise; assert.equal(listens, 0); assert.equal(sessionCloses, 1);
  } else {
    // Session cleanup must start without waiting for the pending listener.
    await sessionClosed.promise; assert.equal(sessionCloses, 1); assert.equal(listenerCloses, 0);
    listening.resolve(listener); await listenerClosed.promise; assert.equal(listenerCloses, 1); assert.equal(sessionCloses, 1);
  }
});

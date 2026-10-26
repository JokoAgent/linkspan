import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { LinkspanError } from '@jokoagent/linkspan-core';
import { negotiateHttpConnect, normalizeHttpConnectAuthority, normalizeHttpConnectProxyOrigin, HTTP_CONNECT_LIMITS } from '../dist/connect.js';

const bytes = value => new TextEncoder().encode(value);
const options = { authority: 'application.test:443' };
function fixture(chunks, overrides = {}) {
  const writes = [], aborts = [];
  let reads = 0, closes = 0;
  const carrier = {
    async read() { reads++; return chunks.shift() ?? null; },
    async write(value) { writes.push(value.slice()); },
    async close() { closes++; },
    abort(value) { aborts.push(value); },
    ...overrides
  };
  return { carrier, writes, aborts, get reads() { return reads; }, get closes() { return closes; } };
}

test('portable CONNECT parses fragmented informational/final headers and preserves binary over-read bytes', async () => {
  const head = bytes('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 Connection Established\r\nX-Controlled: yes\r\n\r\n');
  const f = fixture([head.subarray(0, 7), head.subarray(7, 36), new Uint8Array([...head.subarray(36), 0, 255, 17]), new Uint8Array([2, 3])]);
  const stream = await negotiateHttpConnect(f.carrier, options);
  assert.equal(new TextDecoder().decode(f.writes[0]), 'CONNECT application.test:443 HTTP/1.1\r\nHost: application.test:443\r\n\r\n');
  assert.deepEqual(await stream.read(), new Uint8Array([0, 255, 17]));
  assert.deepEqual(await stream.read(), new Uint8Array([2, 3]));
  assert.equal(await stream.read(), null);
  await stream.close();
  assert.equal(f.closes, 1); assert.equal(f.aborts.length, 0);
});

test('CONNECT 2xx establishes only a carrier and no upstream body framing consumes opaque bytes', async () => {
  const f = fixture([new Uint8Array([...bytes('HTTP/1.0 201 Established\r\nContent-Length: 900\r\n\r\n'), 7, 8, 9])]);
  const stream = await negotiateHttpConnect(f.carrier, options);
  assert.deepEqual(await stream.read(), new Uint8Array([7, 8, 9]));
  await stream.close();
});

for (const response of ['HTTP/9.9 200 Invalid\r\n\r\n', 'NOT HTTP\r\n\r\n', 'HTTP/1.1 200 Truncated\r\n',
  'HTTP/1.1 101 Switching Protocols\r\n\r\n']) test(`invalid CONNECT response cannot expose a stream: ${response.split('\r')[0]}`, async () => {
  const f = fixture([bytes(response)]);
  await assert.rejects(negotiateHttpConnect(f.carrier, options), { code: response.includes('101 Switching') ? 'transport_error' : 'protocol_error' });
  assert.equal(f.aborts.length, 1); assert.equal(f.writes.length, 1);
});

for (const status of [302, 403, 407, 500]) test(`CONNECT ${status} never retries, follows a redirect or adds visitor authentication`, async () => {
  const f = fixture([bytes(`HTTP/1.1 ${status} Controlled-private-message\r\nLocation: https://other.example\r\n\r\n`)]);
  await assert.rejects(negotiateHttpConnect(f.carrier, options), error => {
    assert.equal(error.code, status === 407 ? 'authentication_failed' : 'transport_error');
    assert.equal(error.message.includes('Controlled-private'), false); return true;
  });
  assert.equal(f.aborts.length, 1); assert.equal(f.writes.length, 1);
});

test('a CONNECT header over 16 KiB, excess fields or excess informational responses abort their original carrier', async () => {
  for (const header of [
    `HTTP/1.1 200 OK\r\nX: ${'x'.repeat(HTTP_CONNECT_LIMITS.maximumHeaderBytes)}\r\n\r\n`,
    `HTTP/1.1 200 OK\r\n${'X: a\r\n'.repeat(65)}\r\n`,
    `${'HTTP/1.1 100 Continue\r\n\r\n'.repeat(5)}HTTP/1.1 200 OK\r\n\r\n`
  ]) {
    const f = fixture([bytes(header)]);
    await assert.rejects(negotiateHttpConnect(f.carrier, options), { code: 'protocol_error' });
    assert.equal(f.aborts.length, 1); assert.equal(f.reads, 1);
  }
});

test('invalid authority and cancelled/expired startup release the existing raw carrier before writing', async () => {
  for (const input of ['target', 'target:080', 'target:65536', 'a@target:443', 'target:443\r\nX: injected', '127.1:443']) {
    const f = fixture([]);
    await assert.rejects(negotiateHttpConnect(f.carrier, { authority: input }), { code: 'invalid_argument' });
    assert.equal(f.aborts.length, 1); assert.equal(f.writes.length, 0);
  }
  const controller = new AbortController(); controller.abort();
  for (const extra of [{ signal: controller.signal }, { deadline: Date.now() - 1 }]) {
    const f = fixture([]);
    await assert.rejects(negotiateHttpConnect(f.carrier, { ...options, ...extra }), { code: extra.signal ? 'cancelled' : 'deadline_exceeded' });
    assert.equal(f.writes.length, 0); assert.ok(f.aborts.length >= 1);
  }
  assert.equal(normalizeHttpConnectAuthority('[::1]:443'), '[::1]:443');
  assert.equal(normalizeHttpConnectProxyOrigin('https://proxy.example:8443'), 'https://proxy.example:8443');
  for (const origin of ['https://user:secret@proxy.example', 'https://proxy.example/path', 'https://proxy.example?x=1', 'tcp://proxy.example']) {
    assert.throws(() => normalizeHttpConnectProxyOrigin(origin), { code: 'invalid_argument' });
  }
});

test('owner cancellation interrupts a pending handshake read and aborts only its original raw carrier', async () => {
  const controller = new AbortController();
  const entered = Promise.withResolvers();
  let rejectRead;
  const f = fixture([], { read: () => new Promise((_resolve, reject) => { rejectRead = reject; entered.resolve(); }),
    abort: reason => { f.aborts.push(reason); rejectRead?.(reason); } });
  const pending = negotiateHttpConnect(f.carrier, { ...options, signal: controller.signal });
  await entered.promise;
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  assert.equal(f.writes.length, 1); assert.ok(f.aborts.length >= 1);
});

test('graceful CONNECT close waits for an accepted write, rejects new writes, and does not pre-abort the carrier', async () => {
  const entered = Promise.withResolvers();
  let releaseWrite;
  const events = [];
  const f = fixture([bytes('HTTP/1.1 200 OK\r\n\r\n')], {
    async write(value) { events.push('write'); if (value.length === 1) await new Promise(resolve => { releaseWrite = resolve; entered.resolve(); }); },
    async close() { events.push('close'); }
  });
  const stream = await negotiateHttpConnect(f.carrier, options);
  const write = stream.write(new Uint8Array([1]));
  const close = stream.close();
  await assert.rejects(stream.write(new Uint8Array([2])), { code: 'closed' });
  await entered.promise;
  assert.equal(events.includes('close'), false); assert.equal(f.aborts.length, 0);
  releaseWrite(); await write; await close;
  assert.deepEqual(events, ['write', 'write', 'close']); assert.equal(f.aborts.length, 0);
});

test('a closing native read error cannot cancel the owner of a successful graceful close', async () => {
  let rejectRead, releaseClose;
  let first = true;
  const f = fixture([], {
    read: () => first ? (first = false, Promise.resolve(bytes('HTTP/1.1 200 OK\r\n\r\n'))) : new Promise((_resolve, reject) => { rejectRead = reject; }),
    close: () => new Promise(resolve => { releaseClose = resolve; })
  });
  const stream = await negotiateHttpConnect(f.carrier, options);
  const read = stream.read(); const close = stream.close();
  rejectRead(new LinkspanError('closed', 'Controlled native socket closed'));
  await assert.rejects(read, { code: 'closed' });
  assert.equal(f.aborts.length, 0);
  releaseClose(); await close;
  assert.equal(await stream.read(), null);
});

test('the distributed portable CONNECT entry has no Node import or global Buffer dependency', async () => {
  const [entry, parser, input] = await Promise.all(['connect.js', 'connect-parser.js', 'connect-parser-input.json'].map(name => readFile(new URL(`../dist/${name}`, import.meta.url), 'utf8')));
  assert.equal(/from\s+["']node:/u.test(entry), false);
  assert.equal(/\bBuffer\s*\./u.test(entry + parser), false);
  assert.equal(JSON.parse(input).version, '0.5.10');
});

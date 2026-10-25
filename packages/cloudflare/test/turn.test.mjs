import assert from 'node:assert/strict';
import test from 'node:test';
import { issueCloudflareTurnCredentials, revokeCloudflareTurnCredentials } from '../dist/turn.js';

const response = () => ({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }, {
  urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:3478?transport=tcp', 'turns:turn.cloudflare.com:443?transport=tcp'],
  username: 'issued-user', credential: 'short-password'
}] });
const options = { requestId: 'host-operation-1', ttlSeconds: 600 };
const access = fetch => ({ keyId: 'selected-key', readApiToken: async () => 'publisher-token', fetch });

test('issues generic short-lived TURN material with the exact fixed provider API, then revokes only the issued username', async () => {
  const calls = [];
  const provider = access(async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/revoke') ? new Response(null, { status: 204 }) : Response.json(response(), { status: 201 });
  });
  const started = Date.now();
  const result = await issueCloudflareTurnCredentials(provider, options);
  assert.equal(result.iceServers.length, 1);
  assert.deepEqual(result.iceServers[0].urls, response().iceServers[1].urls);
  assert.equal(result.iceServers[0].credential, 'short-password');
  assert.ok(result.expiresAt >= started + 600_000 && result.expiresAt <= Date.now() + 600_000);
  assert.equal(result.resource.requestId, options.requestId);
  assert.deepEqual(result.resource.usernames, ['issued-user']);
  await revokeCloudflareTurnCredentials(provider, result.resource, { requestId: 'host-operation-1:revoke' });
  assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/selected-key/credentials/generate-ice-servers');
  assert.equal(calls[1].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/selected-key/credentials/issued-user/revoke');
  assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.authorization, 'Bearer publisher-token');
  assert.equal(calls[0].init.body, '{"ttl":600}');
  assert.equal(calls.length, 2);
});

test('cancellation while reading a token never dispatches a late secret', async () => {
  const cancellation = new AbortController();
  let resolveToken;
  let calls = 0;
  const pending = issueCloudflareTurnCredentials({ ...access(async () => { calls++; }),
    readApiToken: () => new Promise(resolve => { resolveToken = resolve; }) }, { ...options, signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(pending, { code: 'cancelled', outcome: 'not_sent' });
  resolveToken('late-token');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0);
});

test('a dispatched request with no response remains unknown and is not retried', async () => {
  let calls = 0;
  await assert.rejects(issueCloudflareTurnCredentials(access(async () => { calls++; throw new Error('vendor-secret-body'); }), options),
    error => error.code === 'outcome_unknown' && error.outcome === 'unknown' && !String(error).includes('vendor-secret-body'));
  assert.equal(calls, 1);
});

test('explicit provider rejection is distinct from an unknown issued credential', async () => {
  await assert.rejects(issueCloudflareTurnCredentials(access(async () => new Response('private vendor error', { status: 403 })), options),
    { code: 'authentication_failed', outcome: 'not_sent' });
  await assert.rejects(issueCloudflareTurnCredentials(access(async () => new Response(null, { status: 503 })), options),
    { code: 'outcome_unknown', outcome: 'unknown' });
  await assert.rejects(issueCloudflareTurnCredentials(access(async () => new Response(null, { status: 408 })), options),
    { code: 'outcome_unknown', outcome: 'unknown' });
});

test('malformed, oversized and substituted provider material never crosses the public API', async () => {
  for (const body of [ { iceServers: [{ urls: ['turn:metadata.internal:80?transport=tcp'], username: 'x', credential: 'x' }] },
    { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }] }, { iceServers: [{ urls: ['https://secrets.example/'], username: 'x', credential: 'x' }] } ]) {
    await assert.rejects(issueCloudflareTurnCredentials(access(async () => Response.json(body, { status: 201 })), options), { code: 'outcome_unknown' });
  }
  await assert.rejects(issueCloudflareTurnCredentials(access(async () => new Response('x'.repeat(16_385), { status: 201 })), options), { code: 'outcome_unknown' });
});

test('rejects invalid TTL, key and foreign cleanup handles without reading a publisher token', async () => {
  let reads = 0;
  const provider = { ...access(async () => { throw new Error('unexpected request'); }), readApiToken: async () => { reads++; return 'token'; } };
  for (const ttlSeconds of [0, 86401, 1.5, NaN]) await assert.rejects(issueCloudflareTurnCredentials(provider, { ...options, ttlSeconds }), { code: 'invalid_argument' });
  await assert.rejects(issueCloudflareTurnCredentials({ ...provider, keyId: '../another-key' }, options), { code: 'invalid_argument' });
  await assert.rejects(revokeCloudflareTurnCredentials(provider,
    { kind: 'cloudflare.turn', keyId: 'foreign-key', requestId: 'foreign', usernames: ['other'], expiresAt: Date.now() + 600_000 },
    { requestId: 'cleanup' }), { code: 'invalid_argument' });
  assert.equal(reads, 0);
});

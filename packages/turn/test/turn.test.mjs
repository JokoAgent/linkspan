import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { issueCoturnRestCredentials } from '../dist/coturn.js';
import { issueTwilioTurnCredentials } from '../dist/twilio.js';
import { retireExpiringTurnResource, validateTurnUrl } from '../dist/index.js';

test('TURN URL validation rejects secure UDP transports regardless of case', () => {
  for (const url of ['https://relay.example', 'turn:relay.example:99999', 'turns:relay.example:443?transport=udp', 'TURNS:relay.example:443?transport=UDP']) assert.equal(validateTurnUrl(url), false);
  for (const url of ['turn:relay.example:3478?transport=udp', 'turn:relay.example:443?transport=tcp', 'turns:relay.example:443?transport=tcp', 'TURNS:relay.example:443?transport=TCP']) assert.equal(validateTurnUrl(url), true);
});

const accountSid = `AC${'a'.repeat(32)}`;
const request = { requestId: 'original-operation', ttlSeconds: 600 };
const payload = { account_sid: accountSid, ttl: '600', ice_servers: [
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: 'turn:global.turn.twilio.com:3478?transport=udp', username: 'issued', credential: 'short-secret' },
  { urls: 'turn:global.turn.twilio.com:443?transport=tcp', username: 'issued', credential: 'short-secret' }
] };
const access = fetch => ({ accountSid, enabled: true, readCredentials: async () => ({ username: accountSid, secret: 'account-secret' }), fetch });

test('Twilio uses the exact selected account endpoint and bounded TTL; retirement truthfully waits for expiry', async () => {
  const calls = [];
  const result = await issueTwilioTurnCredentials(access(async (...args) => { calls.push(args); return Response.json(payload, { status: 201 }); }), request);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Tokens.json`);
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].body, 'Ttl=600');
  assert.equal(result.iceServers.length, 2);
  assert.equal(JSON.stringify(result).includes('account-secret'), false);
  assert.deepEqual(retireExpiringTurnResource(result.resource, { kind: 'twilio.turn', keyId: accountSid, issueRequestId: request.requestId }),
    { state: 'awaiting-expiry', expiresAt: result.expiresAt, individualRevocation: false });
  assert.throws(() => retireExpiringTurnResource(result.resource, { kind: 'twilio.turn', keyId: accountSid, issueRequestId: 'foreign' }), { code: 'invalid_argument' });
});

test('Twilio never retries dispatched unknown effects or exposes upstream errors', async () => {
  let calls = 0;
  await assert.rejects(issueTwilioTurnCredentials(access(async () => { calls++; throw new Error('private-account-content'); }), request),
    error => error.code === 'outcome_unknown' && error.outcome === 'unknown' && !String(error).includes('private-account-content'));
  assert.equal(calls, 1);
  await assert.rejects(issueTwilioTurnCredentials(access(async () => new Response(null, { status: 403 })), request), { code: 'authentication_failed', outcome: 'not_sent' });
  for (const changed of [ { ...payload, account_sid: `AC${'b'.repeat(32)}` },
    { ...payload, ttl: 86400 }, { ...payload, ice_servers: [{ urls: 'turn:metadata.internal:443?transport=tcp', username: 'x', credential: 'x' }] } ]) {
    await assert.rejects(issueTwilioTurnCredentials(access(async () => Response.json(changed, { status: 201 })), request), { code: 'outcome_unknown' });
  }
});

test('cancellation during private credential access never sends a late token', async () => {
  const controller = new AbortController(); let release; let called = false;
  const pending = issueTwilioTurnCredentials({ ...access(async () => { called = true; }), readCredentials: () => new Promise(resolve => { release = resolve; }) }, { ...request, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: 'cancelled' });
  release({ username: accountSid, secret: 'late-secret' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(called, false);
});

test('coturn REST generates interoperable HMAC credentials with an exact TTL and no global secret disclosure', async () => {
  const secret = 'bounded-coturn-shared-secret';
  const result = await issueCoturnRestCredentials({ keyId: 'existing-relay', urls: ['turn:relay.example:3478?transport=udp', 'turns:relay.example:443?transport=tcp'], readSharedSecret: async () => secret }, request);
  const server = result.iceServers[0];
  assert.equal(server.credential, createHmac('sha1', secret).update(server.username).digest('base64'));
  assert.equal(Number(server.username.split(':')[0]) * 1000, result.expiresAt);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(result.resource.revocation, 'ttl-only');
  await assert.rejects(issueCoturnRestCredentials({ keyId: 'relay', urls: ['https://relay.example/'], readSharedSecret: async () => secret }, request), { code: 'invalid_argument' });
});

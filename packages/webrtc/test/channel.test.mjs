import assert from 'node:assert/strict';
import test from 'node:test';
import { openWebRtcChannel } from '../dist/index.js';

class Data extends EventTarget {
  ordered = true; maxPacketLifeTime = null; maxRetransmits = null;
  readyState = 'open'; bufferedAmount = 0; bufferedAmountLowThreshold = 0;
  sent = []; closes = 0;
  send(value) { this.sent.push(new Uint8Array(value)); }
  close() { this.closes++; this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: value.buffer })); }
}
const certificate = new TextEncoder().encode('actual-platform-certificate').buffer;
const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', certificate));
const fingerprint = [...digest].map(value => value.toString(16).padStart(2,'0')).join(':').toUpperCase();
function fixture() {
  const data = new Data(); let closed = 0;
  const peer = { sctp: { transport: { state: 'connected', getRemoteCertificates: () => [certificate] } }, close: () => closed++ };
  return { data, peer, closed: () => closed };
}
test('validates actual DTLS identity before exposing bytes and preserves shared media ownership', async () => {
  const f = fixture();
  const channel = await openWebRtcChannel({ dataChannel: f.data, peerConnection: f.peer, expectedFingerprint: fingerprint });
  await channel.send(new Uint8Array([1,2,3])); assert.deepEqual(f.data.sent[0], new Uint8Array([1,2,3]));
  const received = channel.receive(); f.data.receive(new Uint8Array([4,5])); assert.deepEqual(await received, new Uint8Array([4,5]));
  await channel.close(); assert.deepEqual(await channel.closed, {}); assert.equal(await channel.receive(), null); assert.equal(f.closed(), 0);
});
test('rejects substituted DTLS certificates and unreliable modes before any application send', async () => {
  const f = fixture();
  await assert.rejects(openWebRtcChannel({ dataChannel: f.data, peerConnection: f.peer, expectedFingerprint: '00:'.repeat(31)+'00' }), { code: 'identity_mismatch' });
  assert.equal(f.data.sent.length,0); assert.equal(f.data.closes,1);
  const second = fixture(); second.data.maxRetransmits = 0;
  await assert.rejects(openWebRtcChannel({ dataChannel: second.data, peerConnection: second.peer, expectedFingerprint: fingerprint }), { code: 'invalid_argument' });
});
test('backpressure cancellation retires the exact channel without late sends', async () => {
  const f = fixture();
  const channel = await openWebRtcChannel({ dataChannel: f.data, peerConnection: f.peer, expectedFingerprint: fingerprint });
  f.data.bufferedAmount = 524288;
  const controller = new AbortController();
  const pending = channel.send(new Uint8Array([9]), { signal: controller.signal }); controller.abort();
  await assert.rejects(pending, { code:'cancelled' }); f.data.bufferedAmount=0; f.data.dispatchEvent(new Event('bufferedamountlow'));
  assert.equal(f.data.sent.length,0); assert.equal((await channel.closed).error.code,'cancelled');
});
test('bounds unconsumed messages and refuses text frames', async () => {
  for (const value of [new Uint8Array(65536).buffer, 'untrusted text']) {
    const f=fixture(); const channel=await openWebRtcChannel({ dataChannel:f.data,peerConnection:f.peer,expectedFingerprint:fingerprint });
    f.data.dispatchEvent(new MessageEvent('message',{data:value}));
    await assert.rejects(channel.receive(),{code:'resource_exhausted'});
  }
});

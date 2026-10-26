import assert from 'node:assert/strict';
import test from 'node:test';
import { networkInterfaces } from 'node:os';
import { createOperationScope } from '@jokoagent/linkspan-core';
import { StunProtocol, Message, methods, classes } from 'werift';
import { createNodeWebRtcPeer } from '../dist/index.js';
import { openWebRtcChannel } from '@jokoagent/linkspan-webrtc';

const pin = peer => peer.localDescription.sdp.match(/^a=fingerprint:sha-256 (.+)$/mu)?.[1].trim();
const candidates = peer => (peer.localDescription?.sdp.match(/^a=candidate:.*$/gmu) ?? []).length;
function diagnostic(t, phase, peers = []) {
  // t.diagnostic buffers inside the worker until the test ends. stderr reaches
  // the parent runner even if the worker terminates before producing a result.
  process.stderr.write(`${JSON.stringify({ test: t.name, phase, rssMiB: Math.round(process.memoryUsage().rss / 1048576), heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576), peers: peers.map(peer => ({ connection: peer.connectionState, ice: peer.iceConnectionState, candidates: candidates(peer) })) })}\n`);
}
async function phase(t, name, peers, action) {
  diagnostic(t, `before:${name}`, peers);
  const scope = createOperationScope({ signal: t.signal });
  try { scope.check(); const value = await scope.wait(action()); diagnostic(t, `after:${name}`, peers); return value; }
  finally { scope.dispose(); }
}
async function pair(t) {
  const first = createNodeWebRtcPeer({ iceServers: [] });
  const second = createNodeWebRtcPeer({ iceServers: [] });
  const peers = [first, second];
  // These real peers run on one machine. Use the engine's existing explicit
  // host-candidate input rather than depending on a runner's external NICs.
  for (const peer of peers) peer.setConfiguration({ iceAdditionalHostAddresses: ['127.0.0.1'], iceServers: [] });
  let samples = 0;
  const sampling = setInterval(() => { if (++samples <= 6) diagnostic(t, 'pending-peer-sample', peers); }, 5000);
  t.after(async () => { clearInterval(sampling); diagnostic(t, 'before:peer-cleanup', peers); await first.close(); await second.close(); diagnostic(t, 'after:peer-cleanup', peers); });
  process.stderr.write(`${JSON.stringify({ test: t.name, phase: 'environment', node: process.version, platform: process.platform, architecture: process.arch, interfaces: Object.entries(networkInterfaces()).map(([name, values]) => ({ name, families: values.map(value => value.family), internal: values.every(value => value.internal) })) })}\n`);
  const incoming = new Promise(resolve => { second.ondatachannel = event => resolve(event.channel); });
  const a = first.createDataChannel('linkspan-http', { ordered: true });
  const offer = await phase(t, 'offer', peers, () => first.createOffer());
  await phase(t, 'first-local-description', peers, () => first.setLocalDescription(offer));
  await phase(t, 'second-remote-description', peers, () => second.setRemoteDescription(first.localDescription));
  const answer = await phase(t, 'answer', peers, () => second.createAnswer());
  await phase(t, 'second-local-description', peers, () => second.setLocalDescription(answer));
  await phase(t, 'first-remote-description', peers, () => first.setRemoteDescription(second.localDescription));
  const b = await phase(t, 'incoming-channel', peers, () => incoming);
  return { first, second, a, b };
}

test('real Node DTLS preserves the final reordered DATA packet before stream reset and close', { timeout: 30000 }, async t => {
  const { first, second, a, b } = await pair(t);
  const [client, server] = await phase(t, 'verify-actual-dtls', [first, second], () => Promise.all([
    openWebRtcChannel({ peerConnection: first, dataChannel: a, expectedFingerprint: pin(second), ownsPeerConnection: true }),
    openWebRtcChannel({ peerConnection: second, dataChannel: b, expectedFingerprint: pin(first), ownsPeerConnection: true })
  ]));
  assert.equal(client.remoteFingerprint, pin(second));
  const association = b.sctp.sctp;
  const sendChunk = association.sendChunk.bind(association);
  let delayedPacket = false, resolveDelayed, rejectDelayed, timer;
  const delayed = new Promise((resolve, reject) => { resolveDelayed = resolve; rejectDelayed = reject; });
  void delayed.catch(() => {});
  t.after(() => clearTimeout(timer));
  association.sendChunk = async chunk => {
    // Fault injection uses the real mature SCTP chunk object before DTLS.
    // DCEP is sequence zero; this is the final fragment of application record
    // 128. Return local acceptance, but let a reset overtake this one packet.
    if (!delayedPacket && chunk.type === 0 && chunk.streamSeqNum === 128 && (chunk.flags & 1)) {
      delayedPacket = true;
      timer = setTimeout(() => { void sendChunk(chunk).then(resolveDelayed, rejectDelayed); }, 50);
      return;
    }
    return sendChunk(chunk);
  };
  const bytes = new Uint8Array(2 * 1024 * 1024).map((_, index) => index % 251);
  const received = (async () => {
    const chunks = [];
    for (;;) { const chunk = await client.receive(); if (chunk === null) break; chunks.push(chunk); }
    return Buffer.concat(chunks);
  })();
  await phase(t, 'send-2mib', [first, second], async () => { for (let offset = 0; offset < bytes.length; offset += 16384) await server.send(bytes.subarray(offset, offset + 16384)); });
  await phase(t, 'server-drain-close', [first, second], () => server.close());
  const actual = await phase(t, 'receive-final-eof', [first, second], () => received);
  // Compare every byte without asking an assertion reporter to render a
  // multi-megabyte array diff if a platform truncates the transport.
  assert.equal(actual.length, bytes.length, 'The ordered response must retain its complete byte length.');
  assert.equal(actual.equals(Buffer.from(bytes)), true, 'The ordered response must retain every original byte.');
  assert.equal(delayedPacket, true, 'The real final SCTP DATA packet must exercise the reorder fault.');
  await phase(t, 'delayed-packet-release', [first, second], () => delayed);
  await phase(t, 'client-close', [first, second], () => client.close());
});

test('explicit empty and TURN-only ICE configuration cannot activate an implicit public STUN server', { timeout: 15000 }, async t => {
  const peer = createNodeWebRtcPeer({ iceServers: [] });
  t.after(() => peer.close());
  peer.setConfiguration({ iceAdditionalHostAddresses: ['127.0.0.1'], iceServers: [] });
  peer.createDataChannel('host-ice-configuration');
  const connection = peer.sctp.transport.iceTransport.connection;
  assert.equal(connection.stunServer, undefined);
  peer.setConfiguration({ iceServers: [{ urls: 'turn:127.0.0.1:3478', username: 'fixture-only', credential: 'fixture-only' }] });
  assert.equal(connection.stunServer, undefined);
  assert.deepEqual(connection.turnServer, ['127.0.0.1', 3478]);
  peer.setConfiguration({ iceServers: [] });
  await phase(t, 'empty-ice-gather', [peer], async () => peer.setLocalDescription(await peer.createOffer()));
  assert.equal(connection.stunServer, undefined);
  assert.equal(peer.localDescription.sdp.includes(' typ srflx'), false);
  assert.equal(peer.localDescription.sdp.includes(' typ host'), true);
});

test('an explicitly configured STUN server remains selected and receives actual binding requests', { timeout: 15000 }, async t => {
  const service = new StunProtocol();
  await service.connectionMade(true, undefined, { udp4: '127.0.0.1' });
  t.after(() => service.close());
  let requests = 0;
  service.onRequestReceived.subscribe((request, address) => {
    requests++;
    const reply = new Message(methods.BINDING, classes.RESPONSE, request.transactionId).setAttribute('XOR-MAPPED-ADDRESS', address).addFingerprint();
    void service.sendStun(reply, address);
  });
  const port = service.getExtraInfo()[1];
  const peer = createNodeWebRtcPeer({ iceServers: [{ urls: `stun:127.0.0.1:${port}` }] });
  t.after(() => peer.close());
  peer.setConfiguration({ iceAdditionalHostAddresses: ['127.0.0.1'] });
  peer.createDataChannel('explicit-stun');
  await phase(t, 'explicit-stun-gather', [peer], async () => peer.setLocalDescription(await peer.createOffer()));
  assert.deepEqual(peer.sctp.transport.iceTransport.connection.stunServer, ['127.0.0.1', port]);
  assert.ok(requests > 0);
  assert.equal(peer.localDescription.sdp.includes(' typ srflx'), true);
});

test('real established DTLS refuses a substituted expected certificate', { timeout: 30000 }, async t => {
  const { first, a } = await pair(t);
  await assert.rejects(openWebRtcChannel({ peerConnection: first, dataChannel: a,
    expectedFingerprint: '00:'.repeat(31) + '00', ownsPeerConnection: true }), { code: 'identity_mismatch' });
  assert.equal(a.readyState === 'closing' || a.readyState === 'closed', true);
});

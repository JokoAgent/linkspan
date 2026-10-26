import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createNodeWebRtcPeer } from '../dist/index.js';
import { openWebRtcChannel } from '@jokoagent/linkspan-webrtc';

if (!process.env.LINKSPAN_BROWSER_DRIVER) throw new Error('Set the pinned Playwright driver entry.');
const { chromium } = await import(pathToFileURL(process.env.LINKSPAN_BROWSER_DRIVER).href);
const peers = new Set(), requests = [], errors = [];
const files = new Map([['/core.js', new URL('../../core/dist/index.js', import.meta.url)], ['/webrtc.js', new URL('../../webrtc/dist/index.js', import.meta.url)]]);
const fingerprint = sdp => sdp.match(/^a=fingerprint:sha-256 (.+)$/mu)?.[1].trim();
const server = createServer(async (request, response) => {
  requests.push(request.url);
  try {
    if (request.method === 'POST' && request.url === '/answer') {
      const chunks = []; let size = 0;
      for await (const chunk of request) { size += chunk.length; if (size > 65536) throw new Error('SDP bound'); chunks.push(chunk); }
      const offer = JSON.parse(Buffer.concat(chunks).toString());
      const peer = createNodeWebRtcPeer({ iceServers: [] }); peers.add(peer);
      peer.setConfiguration({ iceAdditionalHostAddresses: ['127.0.0.1'], iceServers: [] });
      peer.ondatachannel = event => {
        void (async () => {
          const channel = await openWebRtcChannel({ peerConnection: peer, dataChannel: event.channel, expectedFingerprint: fingerprint(offer.sdp), ownsPeerConnection: true });
          for (;;) { const bytes = await channel.receive(); if (bytes === null) break; await channel.send(bytes); }
          await channel.close();
        })().catch(error => { if (!['closed', 'cancelled'].includes(error.code)) errors.push(error.code ?? error.name); void peer.close(); });
      };
      await peer.setRemoteDescription(offer);
      await peer.setLocalDescription(await peer.createAnswer());
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(peer.localDescription)); return;
    }
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><script type="importmap">{"imports":{"@jokoagent/linkspan-core":"/core.js"}}</script><button id="connect">Connect</button><script>document.querySelector("button").onclick=async()=>{window.rtc=await import("/webrtc.js")}</script>'); return;
    }
    const file = files.get(request.url);
    if (!file) { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', 'text/javascript'); response.end(await readFile(file));
  } catch { response.writeHead(400); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.LINKSPAN_BROWSER_EXECUTABLE ? { executablePath: process.env.LINKSPAN_BROWSER_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(requests.includes('/webrtc.js'), false);
  await page.click('#connect'); await page.waitForFunction(() => !!window.rtc);
  const result = await page.evaluate(async () => {
    const errors = [];
    const peer = new RTCPeerConnection({ iceServers: [] });
    const data = peer.createDataChannel('linkspan-http', { ordered: true });
    data.addEventListener('error', event => errors.push({ detail: event.error?.errorDetail, cause: event.error?.sctpCauseCode }));
    const gathering = new Promise(resolve => peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') resolve(); }));
    try {
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== 'complete') await gathering;
      const answer = await fetch('/answer', { method: 'POST', body: JSON.stringify(peer.localDescription) }).then(value => value.json());
      await peer.setRemoteDescription(answer);
      const pin = answer.sdp.match(/^a=fingerprint:sha-256 (.+)$/mu)[1].trim();
      const channel = await window.rtc.openWebRtcChannel({ peerConnection: peer, dataChannel: data, expectedFingerprint: pin, ownsPeerConnection: true });
      const total = 2 * 1024 * 1024;
      const reading = (async () => {
        let bytes = 0;
        while (bytes < total) {
          const chunk = await channel.receive(); if (!chunk) throw new Error('Early EOF');
          for (let index = 0; index < chunk.length; index++) if (chunk[index] !== (bytes + index) % 251) throw new Error('Corrupt binary response');
          bytes += chunk.length;
        }
        return bytes;
      })();
      for (let offset = 0; offset < total; offset += 16384) await channel.send(new Uint8Array(16384).map((_, index) => (offset + index) % 251));
      const received = await reading;
      await channel.close();
      return { received, fingerprint: channel.remoteFingerprint === pin, errors };
    } finally { peer.close(); }
  });
  assert.deepEqual(result, { received: 2 * 1024 * 1024, fingerprint: true, errors: [] });
  assert.deepEqual(errors, []);
  assert.equal(requests.some(value => /(?:iroh|tailcat|wasm|werift)/u.test(value)), false);
  console.log(JSON.stringify({ nodeBrowserInterop: true, bytes: result.received, actualDtlsPin: true, selectedModuleOnly: true }));
} finally {
  await browser.close();
  await Promise.all([...peers].map(peer => peer.close()));
  await new Promise(resolve => server.close(resolve));
}

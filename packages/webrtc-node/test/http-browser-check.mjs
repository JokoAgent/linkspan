import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createNodeWebRtcPeer } from '../dist/index.js';
import { openWebRtcChannel } from '@jokoagent/linkspan-webrtc';
import { serveHttp } from '../../http/dist/node.js';
import { HEAD, RESPONSE, DATA, metadata, record as wireRecord, parseMetadata, readRecord, receiveBody } from '../../http/dist/wire.js';
import { LinkspanError } from '@jokoagent/linkspan-core';

if (!process.env.LINKSPAN_BROWSER_DRIVER) throw new Error('Set the pinned Playwright driver entry.');
const { chromium } = await import(pathToFileURL(process.env.LINKSPAN_BROWSER_DRIVER).href);
const peers = new Set(), requests = [], failures = [], events = [];
const pin = sdp => sdp.match(/^a=fingerprint:sha-256 (.+)$/mu)?.[1].trim();
const files = new Map([
  ['/core.js', new URL('../../core/dist/index.js', import.meta.url)],
  ['/webrtc.js', new URL('../../webrtc/dist/index.js', import.meta.url)],
  ['/http/index.js', new URL('../../http/dist/index.js', import.meta.url)],
  ['/http/wire.js', new URL('../../http/dist/wire.js', import.meta.url)],
  ['/http/fetch-body.js', new URL('../../http/dist/fetch-body.js', import.meta.url)]
]);
const maximumEvents = 256;
const record = event => { if (events.length < maximumEvents) events.push(event); };
let applicationOrigin;
const server = createServer(async (request, response) => {
  requests.push(request.url);
  try {
    if (request.url.startsWith('/application/')) {
      response.setHeader('content-type', 'application/json');
      if (request.url === '/application/error') { response.writeHead(412); response.end(JSON.stringify({ code: 'failed_precondition', message: 'Controlled pairing window is closed.' })); return; }
      if (request.url === '/application/empty') { response.writeHead(204); response.end(); return; }
      if (request.url === '/application/blob') { response.setHeader('content-type', 'application/octet-stream'); response.end(Buffer.alloc(2 * 1024 * 1024, 217)); return; }
      if (request.url === '/application/upload') { response.setHeader('content-type', 'application/octet-stream'); request.pipe(response); return; }
      let bytes = 0; for await (const chunk of request) bytes += chunk.length;
      response.end(JSON.stringify({ endpoint: request.url, requestBytes: bytes })); return;
    }
    if (request.method === 'POST' && request.url === '/answer') {
      const chunks = []; let length = 0;
      for await (const chunk of request) { length += chunk.length; if (length > 65536) throw new Error('SDP bound'); chunks.push(chunk); }
      const offer = JSON.parse(Buffer.concat(chunks).toString());
      const peer = createNodeWebRtcPeer({ iceServers: [] }); peers.add(peer);
      peer.setConfiguration({ iceAdditionalHostAddresses: ['127.0.0.1'], iceServers: [] });
      const id = peers.size;
      peer.ondatachannel = event => {
        void (async () => {
          const channel = await openWebRtcChannel({ peerConnection: peer, dataChannel: event.channel, expectedFingerprint: pin(offer.sdp), ownsPeerConnection: true });
          if (offer.scenario && offer.scenario !== 'normal') {
            parseMetadata(await readRecord(channel), HEAD);
            for await (const _chunk of receiveBody(channel, new Headers())) { /* Consume the controlled request. */ }
            await channel.send(metadata(RESPONSE, { status: 200, headers: [['content-type', 'application/json']] }));
            if (offer.scenario === 'owner-cancel') { await channel.closed; await peer.close(); return; }
            await channel.send(wireRecord(DATA, new TextEncoder().encode('{"incomplete":')));
            if (offer.scenario === 'no-end') await channel.close();
            else { channel.abort(new LinkspanError('transport_error', 'Controlled incomplete response.')); await channel.closed; }
            return;
          }
          const traced = {
            closed: channel.closed,
            async send(bytes, options) { record({ id, direction: 'send', kind: bytes[0], bytes: bytes.length }); return channel.send(bytes, options); },
            async receive(options) { const bytes = await channel.receive(options); record({ id, direction: 'receive', kind: bytes?.[0] ?? 'eof' }); return bytes; },
            async close() { record({ id, event: 'node-close-start' }); await channel.close(); record({ id, event: 'node-close-end' }); },
            abort(error) { record({ id, event: 'node-abort', code: error?.code }); channel.abort(error); }
          };
          await serveHttp(traced, { origin: applicationOrigin });
        })().catch(error => { failures.push({ id, code: error.code ?? error.name }); void peer.close(); });
      };
      await peer.setRemoteDescription(offer); await peer.setLocalDescription(await peer.createAnswer());
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(peer.localDescription)); return;
    }
    if (request.url === '/') {
      response.setHeader('content-type', 'text/html');
      response.end('<!doctype html><script type="importmap">{"imports":{"@jokoagent/linkspan-core":"/core.js"}}</script><button id="connect">Connect</button><script>document.querySelector("button").onclick=async()=>{window.rtc=await import("/webrtc.js");window.http=await import("/http/index.js")}</script>'); return;
    }
    const file = files.get(request.url); if (!file) { response.writeHead(404); response.end(); return; }
    response.setHeader('content-type', 'text/javascript'); response.end(await readFile(file));
  } catch { response.writeHead(400); response.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
applicationOrigin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.LINKSPAN_BROWSER_EXECUTABLE ? { executablePath: process.env.LINKSPAN_BROWSER_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage(); await page.goto(applicationOrigin);
  assert.equal(requests.includes('/webrtc.js'), false); assert.equal(requests.includes('/http/index.js'), false);
  await page.click('#connect'); await page.waitForFunction(() => !!window.http);
  const result = await page.evaluate(async () => {
    const events = [], results = [], channelErrors = []; let id = 0, lastChannel, lastPeer, scenario = 'normal';
    const record = event => { if (events.length < 256) events.push(event); };
    const fetchHttp = window.http.createHttpFetch({ origin: 'https://controlled-application.test', async connect(options) {
      const current = ++id;
      const selectedScenario = scenario;
      const peer = new RTCPeerConnection({ iceServers: [] }); const data = peer.createDataChannel('linkspan-http', { ordered: true });
      lastPeer = peer;
      data.addEventListener('error', event => { const error = { id: current, scenario: selectedScenario, event: 'chrome-error', detail: event.error?.errorDetail, cause: event.error?.sctpCauseCode }; channelErrors.push(error); record(error); });
      data.addEventListener('close', () => record({ id: current, event: 'chrome-close' }));
      const gathered = new Promise(resolve => peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') resolve(); }));
      try {
        await peer.setLocalDescription(await peer.createOffer()); if (peer.iceGatheringState !== 'complete') await gathered;
        const answer = await fetch('/answer', { method: 'POST', body: JSON.stringify({ ...peer.localDescription.toJSON(), scenario: selectedScenario }) }).then(value => value.json());
        await peer.setRemoteDescription(answer);
        const fingerprint = answer.sdp.match(/^a=fingerprint:sha-256 (.+)$/mu)[1].trim();
        const channel = await window.rtc.openWebRtcChannel({ ...options, peerConnection: peer, dataChannel: data, expectedFingerprint: fingerprint, ownsPeerConnection: true });
        lastChannel = channel;
        return {
          closed: channel.closed,
          send: (bytes, options) => channel.send(bytes, options),
          async receive(options) { const bytes = await channel.receive(options); if (bytes?.[0] !== 1) record({ id: current, event: 'chrome-record', kind: bytes?.[0] ?? 'eof' }); return bytes; },
          close: () => channel.close(), abort: error => channel.abort(error)
        };
      } catch (error) { peer.close(); throw error; }
    } });
    try {
      for (let round = 0; round < 5; round++) for (const [path, status, method] of [['info',200,'GET'],['discovery',200,'GET'],['error',412,'POST'],['pair',200,'POST'],['empty',204,'GET']]) {
        const response = await fetchHttp(`https://controlled-application.test/application/${path}`, { method, ...(method === 'POST' ? { body: JSON.stringify({ fixture: true }) } : {}) });
        // A slow HTTP consumer must retain authenticated records queued before
        // the remote stream closes; completion cannot depend on render timing.
        if (status !== 204) await lastChannel.closed;
        const body = await response.text(); if (response.status !== status || (status !== 204 && !body.startsWith('{'))) throw new Error('Controlled HTTP response mismatch');
        results.push({ path, status });
      }
      const blob = new Uint8Array(await (await fetchHttp('https://controlled-application.test/application/blob')).arrayBuffer());
      if (blob.length !== 2 * 1024 * 1024 || blob.some(value => value !== 217)) throw new Error('Controlled download mismatch');
      const bytes = new Uint8Array(2 * 1024 * 1024).map((_, index) => index % 251);
      const echo = new Uint8Array(await (await fetchHttp('https://controlled-application.test/application/upload', { method: 'POST', body: bytes })).arrayBuffer());
      if (echo.length !== bytes.length || echo.some((value, index) => value !== bytes[index])) throw new Error('Controlled upload mismatch');
      const negative = [];
      for (scenario of ['no-end', 'abort', 'owner-cancel']) {
        const controller = new AbortController(); let rejected = false, code, receivedHead = false, cancelledImmediately = false;
        try {
          const response = await fetchHttp('https://controlled-application.test/application/negative', { signal: controller.signal });
          receivedHead = response.status === 200;
          if (scenario === 'owner-cancel') { controller.abort(); cancelledImmediately = lastPeer.connectionState === 'closed'; }
          else await lastChannel.closed;
          await response.text();
        } catch (error) { rejected = true; code = error.code ?? error.name; }
        if (!rejected) throw new Error(`An incomplete ${scenario} response was accepted.`);
        if (scenario !== 'abort' && !receivedHead) throw new Error(`The ${scenario} fixture never reached its real HTTP response.`);
        if (scenario === 'owner-cancel' && !cancelledImmediately) throw new Error('Owned peer cancellation was not immediate.');
        negative.push({ scenario, rejected, code, receivedHead, ...(scenario === 'owner-cancel' ? { cancelledImmediately } : {}) });
      }
      return { passed: true, rounds: 5, responses: results.length, binaryBytes: blob.length + echo.length, negative, channelErrors, events };
    } catch (error) { return { passed: false, error: { code: error.code, message: error.message }, responses: results, events }; }
  });
  console.log(JSON.stringify({ ...result, events: result.passed ? undefined : result.events, nodeFailures: failures, nodeEvents: result.passed ? undefined : events }));
  assert.equal(result.passed, true); assert.deepEqual(failures, []);
  assert.equal(result.channelErrors.some(event => event.scenario === 'normal' || event.scenario === 'no-end'), false);
  assert.equal(requests.some(value => /(?:iroh|tailcat|wasm|werift)/u.test(value)), false);
} finally { await browser.close(); await Promise.all([...peers].map(peer => peer.close())); await new Promise(resolve => server.close(resolve)); }

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

if (!process.env.LINKSPAN_BROWSER_DRIVER) throw new Error('Set the pinned Playwright driver entry.');
const { chromium } = await import(pathToFileURL(process.env.LINKSPAN_BROWSER_DRIVER).href);
const requests = [];
const files = new Map([['/core.js',new URL('../../core/dist/index.js',import.meta.url)],['/webrtc.js',new URL('../dist/index.js',import.meta.url)]]);
const server=createServer(async (request,response)=>{
  requests.push(request.url);
  if(request.url==='/') { response.setHeader('content-type','text/html'); response.end('<!doctype html><script type="importmap">{"imports":{"@jokoagent/linkspan-core":"/core.js"}}</script><button id="connect">Connect</button><script>document.querySelector("button").onclick=async()=>{window.rtc=await import("/webrtc.js")}</script>'); return; }
  const file=files.get(request.url); if(!file){response.writeHead(404);response.end();return;}
  response.setHeader('content-type','text/javascript');response.end(await readFile(file));
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch({headless:true,...(process.env.LINKSPAN_BROWSER_EXECUTABLE?{executablePath:process.env.LINKSPAN_BROWSER_EXECUTABLE}:{})});
try {
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(requests.includes('/webrtc.js'),false);
  await page.click('#connect');await page.waitForFunction(()=>!!window.rtc);
  const result=await page.evaluate(async()=>{
    const first=new RTCPeerConnection({iceServers:[]}),second=new RTCPeerConnection({iceServers:[]});
    const incoming=new Promise(resolve=>second.ondatachannel=event=>resolve(event.channel));
    const a=first.createDataChannel('linkspan',{ordered:true});
    const gathered=peer=>peer.iceGatheringState==='complete'?Promise.resolve():new Promise(resolve=>peer.addEventListener('icegatheringstatechange',()=>{if(peer.iceGatheringState==='complete')resolve()}));
    try {
      await first.setLocalDescription(await first.createOffer());await gathered(first);
      await second.setRemoteDescription(first.localDescription);await second.setLocalDescription(await second.createAnswer());await gathered(second);
      await first.setRemoteDescription(second.localDescription);const b=await incoming;
      const pin=peer=>peer.localDescription.sdp.match(/^a=fingerprint:sha-256 (.+)$/m)[1].trim();
      const deadline=Date.now()+15000;
      const [left,right]=await Promise.all([window.rtc.openWebRtcChannel({peerConnection:first,dataChannel:a,expectedFingerprint:pin(second),deadline}),window.rtc.openWebRtcChannel({peerConnection:second,dataChannel:b,expectedFingerprint:pin(first),deadline})]);
      const chunk=new Uint8Array(32768).fill(137);const count=320;
      const reading=(async()=>{let bytes=0;for(let i=0;i<count;i++){const next=await right.receive({deadline:Date.now()+15000});if(next.length!==chunk.length||next.some(value=>value!==137))throw new Error('RTC byte mismatch');bytes+=next.length;}return bytes;})();
      for(let i=0;i<count;i++)await left.send(chunk,{deadline:Date.now()+15000});
      const bytes=await reading;
      const abort=new AbortController();const waiting=right.receive({signal:abort.signal});abort.abort();let cancelled=false;try{await waiting}catch(error){cancelled=error.code==='cancelled'}
      await left.close();return{bytes,cancelled};
    } finally {first.close();second.close();}
  });
  assert.deepEqual(result,{bytes:10485760,cancelled:true});
  assert.equal(requests.some(value=>/iroh|tailcat|wasm/.test(value)),false);
  console.log('Actual browser DTLS certificate pins, 10 MiB ordered transfer, backpressure, cancellation and on-demand loading passed.');
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}

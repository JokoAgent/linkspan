import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';

let active;
mock.module('@jokoagent/linkspan-pinggy', { namedExports: { async startDatagram(config, options) {
  assert.equal(config.runtime,'sdk');assert.match(options.localAddress,/^127\.0\.0\.1:[0-9]+$/u);
  const fixture=active;fixture.started?.();
  const resource={provider:'pinggy',requestId:options.requestId,id:`udp:${options.requestId}`,processId:process.pid,createdByHost:true};
  options.onResource?.(resource);
  if(fixture.pending)await fixture.pending;
  let done;const closed=new Promise(resolve=>{done=resolve;});
  return {resource,publicHost:'temporary.pinggy.link',publicPort:30001,closed,async close(){fixture.stops++;done();}};
} } });
const {startDatagramMapping}=await import('../dist/datagram.js');
const budget={paidEnabled:false,maximumSessionMs:7200000,maximumBytes:1024};
const config={provider:'pinggy',runtime:'sdk',sdkDirectory:process.cwd(),budget};
async function target(t){const socket=createSocket('udp4');socket.on('message',(data,remote)=>socket.send(data,remote.port,remote.address));await new Promise(resolve=>socket.bind(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>socket.close(resolve)));return socket;}

test('selected Pinggy UDP preserves free endpoint, exact owner, bounded time and revocation',async t=>{
  const socket=await target(t);const controller=new AbortController();active={stops:0};const fixture=active;let receipt;
  const mapping=await startDatagramMapping(config,{requestId:'original',signal:controller.signal,onResource(value){receipt=value;},localTarget:{address:'127.0.0.1',port:socket.address().port,ownerId:'capture-original'}});
  assert.equal(mapping.kind,'pinggy.udp');assert.equal(mapping.mapping.publicHost,'temporary.pinggy.link');assert.equal(mapping.mapping.publicPort,30001);assert.equal(mapping.mapping.ownerId,'capture-original');
  assert.ok(mapping.mapping.expiresAt<=Date.now()+3600000);assert.equal(receipt.requestId,'original');assert.equal(receipt.processId,process.pid);
  controller.abort();await mapping.closed;await mapping.close();assert.equal(fixture.stops,1);
});
test('cancelled Pinggy UDP startup remains unknown and closes its late original SDK resource',async t=>{
  const socket=await target(t);const controller=new AbortController();let release,started;
  active={stops:0,pending:new Promise(resolve=>{release=resolve;}),started:()=>started()};const fixture=active;
  const dispatched=new Promise(resolve=>{started=resolve;});
  const operation=startDatagramMapping(config,{requestId:'cancelled-original',signal:controller.signal,localTarget:{address:'127.0.0.1',port:socket.address().port,ownerId:'capture-original'}});
  await dispatched;controller.abort();await assert.rejects(operation,{code:'outcome_unknown',outcome:'unknown'});release();
  for(let i=0;i<50&&fixture.stops===0;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(fixture.stops,1);
});

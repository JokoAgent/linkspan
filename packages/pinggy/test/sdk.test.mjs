import test from 'node:test';
import assert from 'node:assert/strict';
import { openSdkTunnel, pinggyByteMode, selectPinggyOrigin, selectPinggyDatagramEndpoint } from '../dist/sdk.js';

function fixture(start=async()=>['tcp://public.example:4443']) {
  let settings,stops=0,disconnected;
  const tunnel={start,async stop(){stops++;disconnected?.();},setWorkerErrorCallback(){},setTunnelDisconnectedCallback(value){disconnected=value;}};
  const sdk={pinggy:{setDebugLogging(value){assert.equal(value,false);},async createTunnel(value){settings=value;return tunnel;}}};
  return {sdk,get settings(){return settings;},get stops(){return stops;}};
}
for(const type of ['http','tls','tcp','tlstcp','udp'])test(`Pinggy ${type} uses one fixed selected forwarding rule and records before startup`,async()=>{
  const events=[];const value=fixture(async()=>{events.push('start');return [`${type}://public.example:4443`];});
  const carrier=await openSdkTunnel(value.sdk,{type,address:'127.0.0.1:43001',requestId:'original-operation',...(type==='udp'?{listenAddress:'public.example:4443'}:{}),onResource(resource){events.push('record');assert.equal(resource.provider,'pinggy');assert.equal(resource.requestId,'original-operation');assert.equal(resource.processId,process.pid);}});
  assert.deepEqual(events,['record','start']);assert.deepEqual(value.settings.forwarding,[{type,address:'127.0.0.1:43001',...(type==='udp'?{listenAddress:'public.example:4443'}:{})}]);
  assert.equal(value.settings.autoReconnect,false);assert.equal(value.settings.webDebugger,'');assert.deepEqual(value.settings.basicAuth,[]);assert.deepEqual(value.settings.bearerTokenAuth,[]);assert.equal(value.settings.httpsOnly,type==='http');
  await carrier.close();await carrier.close();await carrier.closed;assert.equal(value.stops,1);
});
test('Pinggy rejected journal never starts a tunnel and cancellation retires a pending startup',async()=>{
  let starts=0;const rejected=fixture(async()=>{starts++;return [];});
  await assert.rejects(openSdkTunnel(rejected.sdk,{type:'udp',address:'127.0.0.1:43001',requestId:'original',onResource(){throw new Error('journal_failed');}}),/journal_failed/);
  assert.equal(starts,0);assert.equal(rejected.stops,1);
  const controller=new AbortController();let release;const pending=fixture(()=>new Promise(resolve=>{release=resolve;}));
  const operation=openSdkTunnel(pending.sdk,{type:'tcp',address:'127.0.0.1:43001',requestId:'original',signal:controller.signal});
  while(!release)await new Promise(resolve=>setTimeout(resolve,1));controller.abort();release(['tcp://public.example:4443']);
  await assert.rejects(operation);assert.equal(pending.stops,1);
});
test('Pinggy TLSTCP requires paid consent and distinguishes its raw and TLS-terminated arms',()=>{
  const base={provider:'pinggy',mode:'tlstcp',budget:{paidEnabled:true},publicOrigin:'https://public.example:4443'};
  assert.throws(()=>pinggyByteMode({...base,budget:{paidEnabled:false},tlstcpEndpoint:'tcp'}),{code:'invalid_argument'});
  assert.throws(()=>pinggyByteMode(base),{code:'invalid_argument'});
  assert.deepEqual(pinggyByteMode({...base,tlstcpEndpoint:'tcp'}),{bridge:'tls',scheme:'tcp:'});
  assert.deepEqual(pinggyByteMode({...base,tlstcpEndpoint:'tls'}),{bridge:'http',scheme:'tls:'});
  assert.equal(selectPinggyOrigin(['tls://public.example:4443','tcp://public.example:4443'],{...base,tlstcpEndpoint:'tcp'}),base.publicOrigin);
  assert.equal(selectPinggyOrigin(['tcp://public.example:4443','tls://public.example:4443'],{...base,tlstcpEndpoint:'tls'}),base.publicOrigin);
  assert.throws(()=>selectPinggyOrigin(['tls://public.example:4443'],{...base,tlstcpEndpoint:'tcp'}));
  assert.throws(()=>selectPinggyOrigin(['tcp://substituted.example:4443'],{...base,tlstcpEndpoint:'tcp'}));
});
test('Pinggy UDP accepts a free allocated endpoint or requires its exact configured pair',()=>{
  assert.deepEqual(selectPinggyDatagramEndpoint(['udp://temporary.pinggy.link:30001'],{}),{publicHost:'temporary.pinggy.link',publicPort:30001});
  assert.deepEqual(selectPinggyDatagramEndpoint(['udp://[2001:db8::1]:30001'],{publicHost:'2001:db8::1',publicPort:30001}),{publicHost:'2001:db8::1',publicPort:30001});
  for(const addresses of [['udp://substituted.example:30001'],['udp://public.example:30002'],['udp://secret@public.example:30001'],['udp://public.example:30001/other'],['tcp://public.example:30001']])assert.throws(()=>selectPinggyDatagramEndpoint(addresses,{publicHost:'public.example',publicPort:30001}));
});

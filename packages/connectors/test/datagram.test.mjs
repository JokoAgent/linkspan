import test from 'node:test';
import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { createDatagramBridge, startDatagramMapping } from '../dist/datagram.js';
import { reconcileConnectorResource } from '../dist/index.js';

const budget={paidEnabled:false,maximumBytes:65_536,maximumSessionMs:60_000};
async function socket(t, handler) {
  const value=createSocket('udp4');if(handler)value.on('message',(data,remote)=>handler(value,data,remote));
  await new Promise((resolve,reject)=>{value.once('error',reject);value.bind(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>value.close(resolve)));return value;
}
async function packet(socket,port,value,timeout=1000) {
  const waiting=once(socket,'message');const timer=AbortSignal.timeout(timeout);
  socket.send(value,port,'127.0.0.1');
  return Promise.race([waiting.then(([data])=>data),new Promise((_,reject)=>timer.addEventListener('abort',()=>reject(new Error('packet_timeout')),{once:true}))]);
}
test('UDP bridge preserves messages and peer identity at its one owned target',async t=>{
  const peers=[];const target=await socket(t,(server,data,remote)=>{peers.push(remote.port);server.send(data,remote.port,remote.address);});
  const bridge=await createDatagramBridge({address:'127.0.0.1',port:target.address().port,ownerId:'capture-original'},budget,{maximumPeers:2});t.after(()=>bridge.close());
  const first=await socket(t);const second=await socket(t);
  assert.equal((await packet(first,bridge.port,Buffer.from('one'))).toString(),'one');
  assert.equal((await packet(second,bridge.port,Buffer.from('two'))).toString(),'two');
  assert.equal((await packet(first,bridge.port,Buffer.from('three'))).toString(),'three');
  assert.equal(peers[0],peers[2]);assert.notEqual(peers[0],peers[1]);
});
test('UDP bridge drops oversized messages and excess peers, then expires idle peer sockets',async t=>{
  const accepted=[];const target=await socket(t,(server,data,remote)=>{accepted.push(data.toString());server.send(data,remote.port,remote.address);});
  const bridge=await createDatagramBridge({address:'127.0.0.1',port:target.address().port,ownerId:'capture-original'},budget,{maximumDatagramBytes:256,maximumPeers:1,idleTimeoutMs:1000});t.after(()=>bridge.close());
  const first=await socket(t);const second=await socket(t);
  await assert.rejects(packet(first,bridge.port,Buffer.alloc(257),100),/packet_timeout/);
  assert.equal((await packet(first,bridge.port,Buffer.from('accepted'))).toString(),'accepted');
  await assert.rejects(packet(second,bridge.port,Buffer.from('excess'),100),/packet_timeout/);
  await new Promise(resolve=>setTimeout(resolve,2100));
  assert.equal((await packet(second,bridge.port,Buffer.from('after-idle'))).toString(),'after-idle');
  assert.deepEqual(accepted,['accepted','after-idle']);
});
test('UDP byte budget closes owned mappings and foreign addresses are rejected before effects',async t=>{
  const target=await socket(t,(server,data,remote)=>server.send(data,remote.port,remote.address));
  const bridge=await createDatagramBridge({address:'127.0.0.1',port:target.address().port,ownerId:'capture-original'},{...budget,maximumBytes:1024});t.after(()=>bridge.close());
  const client=await socket(t);client.send(Buffer.alloc(1025),bridge.port,'127.0.0.1');await bridge.exhausted;await bridge.close();await bridge.close();
  for(const address of ['169.254.169.254','192.0.2.1','0.0.0.0','127.1','media.example'])await assert.rejects(createDatagramBridge({address,port:4444,ownerId:'capture-original'},budget),{code:'invalid_argument'});
  await assert.rejects(startDatagramMapping({provider:'pangolin',budget,publicHost:'media.example',publicPort:2222},{requestId:'original',localTarget:{address:'127.0.0.1',port:4444,ownerId:'capture-original'},startupTimeoutMs:1}),{code:'invalid_argument'});
});
test('native target-close ICMP retires the entire UDP publication instead of reconnecting a reused port',{
  skip: process.platform==='win32' ? 'Windows libuv suppresses UDP connection-reset ICMP; native Main retirement ACK owns that lifecycle.' : false,
  timeout:4000
},async t=>{
  const target=createSocket('udp4');target.on('message',(data,remote)=>target.send(data,remote.port,remote.address));
  await new Promise(resolve=>target.bind(0,'127.0.0.1',resolve));const port=target.address().port;
  const bridge=await createDatagramBridge({address:'127.0.0.1',port,ownerId:'capture-original'},budget);t.after(()=>bridge.close());
  const client=await socket(t);assert.equal((await packet(client,bridge.port,Buffer.from('before-close'))).toString(),'before-close');
  await new Promise(resolve=>target.close(resolve));client.send(Buffer.from('closed-target'),bridge.port,'127.0.0.1');
  await bridge.exhausted;await bridge.close();
  let forwarded=0;const replacement=createSocket('udp4');replacement.on('message',()=>forwarded++);
  await new Promise(resolve=>replacement.bind(port,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>replacement.close(resolve)));
  client.send(Buffer.from('cannot-rebind-original-capture'),bridge.port,'127.0.0.1');await new Promise(resolve=>setTimeout(resolve,100));assert.equal(forwarded,0);
});
test('zrok recovery cannot retire a persistent share without its exact original cloud receipt',async()=>{
  const resource={provider:'zrok',requestId:'original',id:'helper:original',createdByHost:true,processId:2_000_000_000};
  const config={provider:'zrok',budget};
  assert.deepEqual(await reconcileConnectorResource(config,resource,{requestId:'original'}),{state:'outcome_unknown'});
  await assert.rejects(reconcileConnectorResource(config,{...resource,providerResourceId:'share',providerResourceOwner:'other-owner'},{requestId:'original'}),{code:'invalid_argument'});
  await assert.rejects(reconcileConnectorResource(config,{...resource,createdByHost:false},{requestId:'original'}),{code:'invalid_argument'});
});
test('new UDP providers reject unsafe or inconsistent endpoint configuration before effects',async()=>{
  const options={requestId:'original',localTarget:{address:'127.0.0.1',port:4444,ownerId:'capture-original'}};
  const frp={provider:'frp',budget,publicHost:'public.example',publicPort:4444,serverAddress:'relay.example',serverPort:7000,token:'publisher',serverName:'relay.example',remotePort:5555};
  await assert.rejects(startDatagramMapping(frp,options),{code:'invalid_argument'});
  await assert.rejects(startDatagramMapping({provider:'pinggy',runtime:'ssh',sdkDirectory:process.cwd(),budget},options),{code:'invalid_argument'});
  await assert.rejects(startDatagramMapping({provider:'pinggy',runtime:'sdk',sdkDirectory:process.cwd(),publicHost:'public.example',budget},options),{code:'invalid_argument'});
  await assert.rejects(startDatagramMapping({provider:'rathole',budget,publicHost:'public.example',publicPort:4444,remoteAddress:'relay.example:7000',serviceName:'../../other',token:'publisher'},options),{code:'invalid_argument'});
});

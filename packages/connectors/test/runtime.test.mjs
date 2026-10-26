import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { createOriginBridge, startWithLifecycle, reconcileConnectorResource, validateOptions } from '../dist/runtime.js';
import { origin, budget } from './fixtures/origin.mjs';
import { connectorHelperArtifact } from '../dist/artifacts.js';

test('TLS-incomplete upstream Linux ARM rathole is not accepted as a prepared full-mode release',()=>{
  assert.throws(()=>connectorHelperArtifact('rathole','linux-arm64'),{code:'unavailable'});
  assert.equal(connectorHelperArtifact('rathole','linux-x64').version,'0.5.0');
});

function get(bridge, headers={}) {
  return new Promise((resolve,reject)=>{const req=request({host:bridge.host,port:bridge.port,path:'/',headers},res=>{let text='';res.on('data',data=>text+=data);res.once('end',()=>resolve(text));});req.once('error',reject);req.end();});
}
test('L7 origin bridge uses fixed CA/SNI even when provider changes Host',async t=>{
  let received=0;
  const app=await origin(t,(req,res)=>{received++;assert.equal(req.socket.servername,'carrier.test');res.end(req.headers.host);});
  const bridge=await createOriginBridge(app.options,budget,'http');t.after(()=>bridge.close());
  assert.equal(await get(bridge,{host:'169.254.169.254'}),'169.254.169.254');
  assert.equal(received,1);
  const wrong=await createOriginBridge({...app.options,originServerName:'untrusted.test'},budget,'http');t.after(()=>wrong.close());
  await assert.rejects(get(wrong));assert.equal(received,1);
});
test('origin bridge rejects ambiguous loopback spellings, plaintext and public destinations',async t=>{
  const app=await origin(t);
  for(const value of ['https://127.1:4444','https://2130706433:4444','http://127.0.0.1:4444','https://192.168.1.2:4444','https://169.254.169.254:4444'])await assert.rejects(createOriginBridge({...app.options,localOrigin:value},budget,'http'),{code:'invalid_argument'});
});

test('only selected tcpmux accepts a literal-loopback Noise target without HTTPS credentials',async()=>{
  const options={requestId:'raw-noise-owner',encryptedStreamTarget:{address:'127.0.0.1',port:23456}};
  assert.equal(validateOptions(options,'stream').href,'tcp://127.0.0.1:23456');
  assert.equal(validateOptions({...options,encryptedStreamTarget:{address:'::1',port:23456}},'stream').hostname,'[::1]');
  for(const address of ['localhost','127.1','2130706433','192.168.1.2','169.254.169.254'])assert.throws(()=>validateOptions({...options,encryptedStreamTarget:{address,port:23456}},'stream'),{code:'invalid_argument'});
  assert.throws(()=>validateOptions(options,'tls'),{code:'invalid_argument'});
  assert.throws(()=>validateOptions({...options,originCaPool:'unexpected.pem'},'stream'),{code:'invalid_argument'});
  for(const mode of ['http','tls'])assert.throws(()=>validateOptions({requestId:'no-certificate'},mode),{code:'invalid_argument'});
  await assert.rejects(startWithLifecycle({provider:'localtunnel',budget},options,'stream',()=>assert.fail('An unrelated provider must never acquire a raw target.')),{code:'invalid_argument'});
  await assert.rejects(startWithLifecycle({provider:'frp',mode:'tcpmux',budget},options,'tls',()=>assert.fail('A tcpmux provider must never acquire an HTTPS target.')),{code:'invalid_argument'});
});
test('traffic exhaustion retires the fixed origin bridge instead of buffering unbounded bytes',async t=>{
  const app=await origin(t);
  const bridge=await createOriginBridge(app.options,{...budget,maximumBytes:1024},'http');t.after(()=>bridge.close());
  const write=new Promise(resolve=>{const req=request({host:bridge.host,port:bridge.port,path:'/',method:'POST'},res=>{res.resume();res.once('end',resolve);});req.once('error',resolve);req.end(Buffer.alloc(4096));});
  await Promise.all([bridge.exhausted,write]);
  await assert.rejects(get(bridge));
});
test('cancellation observes and cleans a late carrier creation without exposing an unrelated handle',async t=>{
  const app=await origin(t);const controller=new AbortController();let cleanup=0;let release;
  const pending=new Promise(resolve=>{release=resolve;});let end;
  const closed=new Promise(resolve=>{end=resolve;});
  const operation=startWithLifecycle({provider:'localtunnel',budget},{...app.options,signal:controller.signal},'http',async()=>{await pending;return{publicOrigin:'https://carrier.example',resource:{provider:'localtunnel',requestId:app.options.requestId,id:'owned-id',createdByHost:true},closed,async close(){cleanup++;end();}};});
  await new Promise(resolve=>setTimeout(resolve,30));controller.abort();
  await assert.rejects(operation);release();await new Promise(resolve=>setTimeout(resolve,30));assert.equal(cleanup,1);
});
test('reconciliation cannot kill an unrelated live PID or accept another operation receipt',async()=>{
  const config={provider:'localtunnel',budget};
  const resource={provider:'localtunnel',requestId:'original',id:'owned',createdByHost:true,processId:process.pid};
  assert.deepEqual(await reconcileConnectorResource(config,resource,{requestId:'original'}),{state:'outcome_unknown'});
  await assert.rejects(reconcileConnectorResource(config,resource,{requestId:'replacement'}),{code:'invalid_argument'});
});

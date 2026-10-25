import test from 'node:test';
import assert from 'node:assert/strict';
import { createNetbirdPublicResource, findNetbirdPublicResource, deleteNetbirdPublicResource } from '../dist/netbird.js';
const base={managementUrl:'https://api.netbird.io',apiToken:'publisher-resource-token',requestId:'random-host-operation',mode:'http',domain:'owned.example.net',peerId:'dedicated-peer',targetPort:443};
const response=(value,status=200)=>new Response(JSON.stringify(value),{status});
test('public proxy uses one dedicated peer with no visitor authentication and preserves unknown writes',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const bad of [()=>response({},500),()=>response({},408),()=>new Response('invalid-json'),()=>response({data:'x'.repeat(1024*1024+1)}),()=>{throw new Error('lost result');}]){
    globalThis.fetch=async(_url,options)=>{if(options.method==='GET')return response([]);const value=JSON.parse(options.body);assert.equal(value.private,false);assert.deepEqual(value.auth,{});assert.equal(value.targets.length,1);assert.equal(value.targets[0].target_id,base.peerId);return bad();};
    await assert.rejects(createNetbirdPublicResource(base),{code:'outcome_unknown',outcome:'unknown'});
  }
});
test('every L4 mode preserves the allocated public port independently of its peer listener',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const mode of ['tls','tcp','udp']){
    let created;const options={...base,mode,targetPort:4444,listenPort:0};
    globalThis.fetch=async(_url,request)=>{if(request.method==='GET')return response([]);const body=JSON.parse(request.body);assert.equal(body.listen_port,0);assert.equal(body.targets[0].port,4444);assert.equal(body.targets[0].protocol,mode==='udp'?'udp':'tcp');created={...body,id:`exact-${mode}`,listen_port:32145};return response(created);};
    const resource=await createNetbirdPublicResource(options);assert.equal(resource.listenPort,32145);
    globalThis.fetch=async()=>response(created);
    assert.deepEqual(await findNetbirdPublicResource({...options,expectedResource:resource}),resource);
    globalThis.fetch=async()=>response({...created,listen_port:32146});
    await assert.rejects(findNetbirdPublicResource({...options,expectedResource:resource}),{code:'identity_mismatch'});
    await assert.rejects(createNetbirdPublicResource({...options,listenPort:32145,expectedResource:resource}),{code:'identity_mismatch'});
  }
});
test('public proxy candidates never gain cleanup ownership from their name alone',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let created;
  globalThis.fetch=async(_url,options)=>{if(options.method==='GET')return response([]);created={...JSON.parse(options.body),id:'specific-proxy'};return response(created);};
  const owned=await createNetbirdPublicResource(base);assert.equal(owned.createdByHost,true);
  let writes=0;globalThis.fetch=async(_url,options)=>{if(options.method!=='GET')writes++;return response([created]);};
  const candidate=await findNetbirdPublicResource(base);assert.equal(candidate.createdByHost,false);
  await assert.rejects(createNetbirdPublicResource(base),{code:'outcome_unknown'});
  await assert.rejects(deleteNetbirdPublicResource({...base,resource:candidate}),{code:'invalid_argument'});assert.equal(writes,0);
  globalThis.fetch=async()=>response({...created,id:'replacement-id'});
  await assert.rejects(deleteNetbirdPublicResource({...base,resource:owned}),{code:'identity_mismatch'});
  globalThis.fetch=async()=>new Response('',{status:404});
  await assert.rejects(createNetbirdPublicResource({...base,expectedResource:owned}),{code:'outcome_unknown'});
});

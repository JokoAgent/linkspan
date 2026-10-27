import test from 'node:test';
import assert from 'node:assert/strict';
import { createDevTunnel, findDevTunnel, getDevTunnelMaterial, deleteDevTunnel, start } from '../dist/index.js';
const base={publisherAccessToken:'Bearer publisher-token',requestId:'random-original-operation',clusterId:'use',port:443};
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
test('anonymous Dev Tunnel create uses a stable explicit ID and cannot retry unknown writes with a new ID',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const bad of [()=>json({},500),()=>json({},408),()=>json({tunnelId:'wrong-id'}),()=>new Response('invalid-json'),()=>json({data:'x'.repeat(270000)}),()=>{throw new Error('lost connection');}]){
    const writes=[];globalThis.fetch=async(url,options)=>{if(options.method==='GET')return json({},404);writes.push({url:String(url),method:options.method,body:JSON.parse(options.body)});return bad();};
    await assert.rejects(createDevTunnel(base),{code:'outcome_unknown',outcome:'unknown'});assert.equal(writes.length,1);assert.equal(writes[0].method,'PUT');assert.deepEqual(writes[0].body.accessControl.entries[0].scopes,['connect']);assert.equal(writes[0].body.accessControl.entries[0].type,'Anonymous');
  }
});
test('exact original Dev Tunnel material refresh is GET-only, while cleanup requests anonymous access-control evidence',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let created;
  globalThis.fetch=async(_url,options)=>{if(options.method==='GET')return json({},404);created={...JSON.parse(options.body),clusterId:base.clusterId,accessTokens:{host:'private-host-token'},ports:JSON.parse(options.body).ports.map(port=>({...port,portForwardingUris:['https://owned-443.use.devtunnels.ms']}))};return json(created);};
  const first=await createDevTunnel(base);assert.equal(first.resource.createdByHost,true);assert.equal(first.hostAccessToken,'private-host-token');
  let writes=0;globalThis.fetch=async(url,options)=>{assert.equal(options.method,'GET');assert.equal(new URL(url).searchParams.get('includeAccessControl'),'true');return json({...created,accessTokens:{host:'refreshed-private-token'}});};
  const refreshed=await getDevTunnelMaterial({...base,resource:first.resource});assert.equal(refreshed.hostAccessToken,'refreshed-private-token');assert.deepEqual(refreshed.resource,first.resource);
  globalThis.fetch=async(_url,options)=>{if(options.method!=='GET')writes++;return json({},404);};
  await assert.rejects(getDevTunnelMaterial({...base,resource:first.resource}),{code:'outcome_unknown'});assert.equal(writes,0);
  globalThis.fetch=async(url,options)=>{if(options.method==='GET'){assert.equal(new URL(url).searchParams.get('includeAccessControl'),'true');return json(created);}writes++;return new Response(null,{status:204});};
  await deleteDevTunnel({...base,resource:first.resource});assert.equal(writes,1);
});
test('Dev Tunnel public configuration rejects control characters before loading a connection',async()=>{
  await assert.rejects(start({provider:'dev-tunnels',tunnelId:'id\nsecret',clusterId:'use',hostAccessToken:'private',publicOrigin:'https://entry.example',port:443},{}),{code:'invalid_argument'});
});

test('Dev Tunnel resource lookup cancels a stalled response and never waits for its producer cleanup', { timeout: 5000 }, async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  let requests = 0, cancelled = 0;
  globalThis.fetch = async () => {
    requests++;
    return new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }));
  };
  await assert.rejects(findDevTunnel({ ...base, deadline: Date.now() - 1 }), { code: 'deadline_exceeded' });
  assert.equal(requests, 0);
  await assert.rejects(findDevTunnel({ ...base, deadline: Date.now() + 100 }));
  assert.equal(requests, 1); assert.equal(cancelled, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { createNamedTunnel, createNamedTunnelSecret, findNamedTunnel, deleteNamedTunnel } from '../dist/index.js';

const base={accountId:'1'.repeat(32),apiToken:'publisher-token-only',requestId:'random-original-operation',tunnelSecret:Buffer.alloc(32,7).toString('base64')};
const id='01234567-89ab-cdef-0123-456789abcdef';
const reply=(result,status=200)=>new Response(JSON.stringify({success:true,result}),{status,headers:{'content-type':'application/json'}});
test('named create only uses local ingress and uncertain provider effects remain unknown',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
  for(const response of [()=>new Response('ambiguous',{status:500}),()=>new Response('retry',{status:408}),()=>new Response('{invalid'),()=>reply('x'.repeat(70000)),()=>{throw new Error('connection lost');}]) {
    const calls=[];globalThis.fetch=async(url,options)=>{calls.push(options.method);if(options.method==='GET')return reply([]);const body=JSON.parse(options.body);assert.equal(body.config_src,'local');assert.equal(body.tunnel_secret,base.tunnelSecret);return response();};
    await assert.rejects(createNamedTunnel(base),{code:'outcome_unknown',outcome:'unknown'});assert.deepEqual(calls,['GET','POST']);
  }
  assert.equal(Buffer.from(createNamedTunnelSecret(),'base64').length,32);
});
test('name-only discovery cannot establish ownership, delete, or create a replacement',async t=>{
  const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});let resourceName;let calls=[];
  globalThis.fetch=async(url,options)=>{calls.push(options.method);if(options.method==='GET'){resourceName=new URL(url).searchParams.get('name');return reply([{id,name:resourceName,config_src:'local'}]);}throw new Error('Unexpected write');};
  const candidate=await findNamedTunnel(base);assert.equal(candidate.createdByHost,false);
  await assert.rejects(createNamedTunnel(base),{code:'outcome_unknown'});
  await assert.rejects(deleteNamedTunnel({...base,resource:candidate}),{code:'invalid_argument'});
  assert.deepEqual(calls,['GET','GET']);
  const resource={...candidate,createdByHost:true};calls=[];
  globalThis.fetch=async(url,options)=>{calls.push(options.method);assert.ok(url.endsWith('/'+id));return reply({id,name:resourceName,config_src:'local'});};
  assert.equal((await createNamedTunnel({...base,expectedResource:resource})).resource.tunnelId,id);assert.deepEqual(calls,['GET']);
  globalThis.fetch=async()=>new Response('',{status:404});
  await assert.rejects(createNamedTunnel({...base,expectedResource:resource}),{code:'outcome_unknown'});
});

import test from"node:test";
import assert from"node:assert/strict";
import{readFile}from"node:fs/promises";
import{issueIrohRelayLease,inspectIrohRelayLease,createIrohTicket}from"../dist/index.js";

test("official signed relay leases bind only relay-use to the exact recipient and actual expiry",async()=>{
  const fixture=JSON.parse(await readFile(new URL("./protocol-fixture.json",import.meta.url),"utf8"));const before=Date.now();
  const lease=await issueIrohRelayLease({...fixture,ttlSeconds:60});
  const decoded=await inspectIrohRelayLease(lease.relayToken);
  assert.equal(decoded.audience,fixture.endpointId);assert.deepEqual(decoded.scope,["relay:use"]);assert.equal(decoded.expiresAt,lease.expiresAt);
  assert.ok(lease.expiresAt>=before+59000&&lease.expiresAt<=Date.now()+60000);
  const changed=lease.relayToken.slice(0,12)+(lease.relayToken[12]==="a"?"b":"a")+lease.relayToken.slice(13);
  await assert.rejects(inspectIrohRelayLease(changed),error=>error.code==="invalid_argument");
  await assert.rejects(issueIrohRelayLease({...fixture,ttlSeconds:86401}),error=>error.code==="invalid_argument");
  const ticket=await createIrohTicket({endpointId:fixture.endpointId,relayUrls:["https://relay.example.com","https://other-relay.example.com"]});assert.equal(typeof ticket,"string");assert.ok(ticket.length>32);
  assert.equal(JSON.stringify(lease).includes(fixture.apiSecret),false);
});

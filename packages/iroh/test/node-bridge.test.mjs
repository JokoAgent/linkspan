import test from "node:test";
import assert from "node:assert/strict";
import { createIrohBridgeHost,listenIroh } from "../dist/node.js";
import { createIrohBridgeClient } from "../dist/bridge.js";
import { createIdentity } from "@jokoagent/linkspan-noise";

test("separate native renderer hosts share backend identity but retain their own authenticated streams",{skip:!process.env.LINKSPAN_IROH_RUNTIME_DIR,timeout:20000},async t=>{
  const identity=await createIdentity();const listener=await listenIroh({identity,relayUrls:[],deadline:Date.now()+10000});t.after(()=>listener.close());
  const a=createIrohBridgeHost();const b=createIrohBridgeHost();t.after(()=>{a.dispose();b.dispose();});
  const first=createIrohBridgeClient(a);const second=createIrohBridgeClient(b);const key=await first.createIrohIdentity();
  const options={ticket:listener.ticket,expectedEndpointId:listener.endpointId,expectedPublicKey:identity.publicKey,clientKey:key.privateKey,relayUrls:[],deadline:Date.now()+10000};
  const firstAccepted=listener.accept({deadline:Date.now()+10000});const channel=await first.connectIroh(options);const peerA=await firstAccepted;t.after(()=>{channel.abort();peerA?.abort();});
  const secondAccepted=listener.accept({deadline:Date.now()+10000});const other=await second.connectIroh(options);const peerB=await secondAccepted;t.after(()=>{other.abort();peerB?.abort();});
  a.dispose();await channel.closed;
  await assert.rejects(first.createIrohIdentity(),error=>error.code==="closed");
  await other.send(Uint8Array.of(31,0,255));assert.deepEqual(await peerB.receive(),Uint8Array.of(31,0,255));
  await other.close();assert.deepEqual(await other.closed,{});assert.deepEqual(await peerB.closed,{});
});

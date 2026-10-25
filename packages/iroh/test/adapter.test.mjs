import test from "node:test";
import assert from "node:assert/strict";
import { createIrohApi } from "../dist/common.js";
import { createIdentity } from "@jokoagent/linkspan-noise";

test("iroh validates trusted material before loading a runtime", async () => {
  let loads = 0;
  const api = createIrohApi(async () => { loads++; throw new Error("unavailable"); });
  await assert.rejects(api.connectIroh({ ticket: "locator", expectedEndpointId: "forged", expectedPublicKey: "missing" }),error => error.code === "invalid_argument");
  assert.equal(loads,0);
});
test("a locator cannot replace the separately trusted SDK endpoint", async () => {
  let aborted = false;
  const api = createIrohApi(async () => ({ connect: async () => ({ remoteEndpointId: "b".repeat(64), abort() { aborted = true; } }) }));
  await assert.rejects(api.connectIroh({ ticket: "endpoint".repeat(4), expectedEndpointId: "a".repeat(64), expectedPublicKey: `ed25519:${"1".repeat(64)}` }),error => error.code === "identity_mismatch");
  assert.equal(aborted,true);
});

test("a malformed real SDK peer cannot close the listener for the following authenticated peer", {skip:!process.env.LINKSPAN_IROH_RUNTIME_DIR,timeout:20000},async t=>{
  const {createIrohRuntime}=await import("../../iroh-node/dist/index.js");
  const runtime=await createIrohRuntime();const identity=await createIdentity();const api=createIrohApi(async()=>runtime);
  const listener=await api.listenIroh({identity,relayUrls:[],deadline:Date.now()+10000});t.after(()=>listener.close());
  const accepted=listener.accept({deadline:Date.now()+10000});
  const bad=await runtime.connect({ticket:listener.ticket,expectedEndpointId:listener.endpointId,deadline:Date.now()+10000});
  await bad.write(Uint8Array.of(0,0,0,0));bad.abort();
  const good=await api.connectIroh({ticket:listener.ticket,expectedEndpointId:listener.endpointId,expectedPublicKey:identity.publicKey,deadline:Date.now()+10000});t.after(()=>good.abort());
  const peer=await accepted;assert.ok(peer);t.after(()=>peer.abort());
  await good.send(Uint8Array.of(73,13));assert.deepEqual(await peer.receive(),Uint8Array.of(73,13));
  await good.close();assert.deepEqual(await good.closed,{});assert.deepEqual(await peer.closed,{});
});

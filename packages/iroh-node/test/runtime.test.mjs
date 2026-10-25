import test from "node:test";
import assert from "node:assert/strict";
import { createIrohRuntime } from "../dist/index.js";
const directSkip=!process.env.LINKSPAN_IROH_RUNTIME_DIR?"The target runtime has not been prepared":false;

test("the prepared runtime supports repeated factory initialization and mature SDK identity generation",{skip:!process.env.LINKSPAN_IROH_RUNTIME_DIR},async()=>{
  const first=await createIrohRuntime();const second=await createIrohRuntime();
  const a=await first.generateIdentity();const b=await second.generateIdentity();
  assert.match(a.publicKey,/^[0-9a-f]{64}$/u);assert.match(b.privateKey,/^[0-9a-f]{64}$/u);assert.notEqual(a.publicKey,b.publicKey);
});

test("the prepared native SDK authenticates actual peers and exchanges bounded binary bytes", { skip: directSkip, timeout: 30000 }, async t => {
  const runtime = await createIrohRuntime();
  const listener = await runtime.listen({ relayUrls: [], deadline: Date.now()+10000 });
  t.after(() => listener.close());
  const incoming = listener.accept({ deadline: Date.now()+10000 });
  const client = await runtime.connect({ ticket:listener.ticket,expectedEndpointId:listener.endpointId,deadline:Date.now()+10000 });
  t.after(() => client.abort());
  const sent = client.write(Uint8Array.of(0,255,19));
  const server = await incoming; assert.ok(server);
  t.after(() => server.abort());
  await sent;
  assert.deepEqual(await server.read(),Uint8Array.of(0,255,19));
  await assert.rejects(runtime.connect({ticket:listener.ticket,expectedEndpointId:"a".repeat(64)}), error => error.code === "identity_mismatch");
});

test("parallel connections using one persistent backend key survive another stream closing",{skip:directSkip,timeout:30000},async t=>{
  const runtime=await createIrohRuntime();const identity=await runtime.generateIdentity();const listener=await runtime.listen({relayUrls:[],deadline:Date.now()+10000});t.after(()=>listener.close());
  const options={ticket:listener.ticket,expectedEndpointId:listener.endpointId,clientKey:identity.privateKey,deadline:Date.now()+10000};
  const firstIncoming=listener.accept({deadline:Date.now()+10000});const first=await runtime.connect(options);t.after(()=>first.abort());await first.write(Uint8Array.of(1));const a=await firstIncoming;t.after(()=>a?.abort());assert.deepEqual(await a.read(),Uint8Array.of(1));
  const secondIncoming=listener.accept({deadline:Date.now()+10000});const second=await runtime.connect(options);t.after(()=>second.abort());await second.write(Uint8Array.of(2));const b=await secondIncoming;t.after(()=>b?.abort());assert.deepEqual(await b.read(),Uint8Array.of(2));
  assert.equal(a.remoteEndpointId,b.remoteEndpointId);first.abort();await second.write(Uint8Array.of(3));assert.deepEqual(await b.read(),Uint8Array.of(3));
});

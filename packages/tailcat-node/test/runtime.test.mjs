import test from "node:test";
import assert from "node:assert/strict";
import { createTailcatRuntime } from "../dist/index.js";

test("the fixed helper generates host-owned identity and rejects an invalid locator before connecting", { skip: !process.env.LINKSPAN_TAILCAT_RUNTIME_DIR, timeout: 10000 }, async t => {
  const runtime = await createTailcatRuntime(); t.after(() => runtime.dispose());
  const identity = await runtime.generateIdentity();
  assert.match(identity.publicKey,/^nodekey:[0-9a-f]{64}$/u);
  assert.match(identity.presharedKey,/^psk:[0-9a-f]{64}$/u);
  assert.match(identity.privateKey,/^privkey:[0-9a-f]{64}$/u);
  await assert.rejects(runtime.connect({address:"tcINVALID",expectedEndpointId:identity.publicKey,port:8080}),error => error.code === "invalid_argument");
  await assert.rejects(runtime.listen({serverKey:`privkey:${"0".repeat(64)}`,allowedClients:[identity.publicKey]}),error=>error.code==="invalid_argument");
});

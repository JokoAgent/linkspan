import test from "node:test";
import assert from "node:assert/strict";
import { createTailcatBridgeHost } from "../dist/node.js";
import { createTailcatBridgeClient } from "../dist/bridge.js";

test("each native renderer host releases only its own helper reference",{skip:!process.env.LINKSPAN_TAILCAT_RUNTIME_DIR},async t=>{
  const a=createTailcatBridgeHost();const b=createTailcatBridgeHost();t.after(()=>{a.dispose();b.dispose();});
  const first=createTailcatBridgeClient(a);const second=createTailcatBridgeClient(b);
  const identity=await first.createTailcatIdentity();assert.match(identity.privateKey,/^privkey:[0-9a-f]{64}$/u);
  a.dispose();await assert.rejects(first.createTailcatIdentity(),error=>error.code==="closed");
  const other=await second.createTailcatIdentity();assert.match(other.publicKey,/^nodekey:[0-9a-f]{64}$/u);
});

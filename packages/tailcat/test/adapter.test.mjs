import test from "node:test";
import assert from "node:assert/strict";
import { createTailcatApi } from "../dist/common.js";

test("tailcat validates trusted material without loading the optional runtime", async () => {
  let loads = 0;
  const api = createTailcatApi(async () => { loads++; throw new Error("unavailable"); });
  await assert.rejects(api.connectTailcat({ address: "tcSECRET", expectedEndpointId: "forged", port: 80, expectedPublicKey: "missing" }),error => error.code === "invalid_argument");
  assert.equal(loads,0);
});
test("tailcat listeners require explicit client admission and never implicitly enable a public allow-all", async () => {
  let loads = 0;
  const api = createTailcatApi(async () => { loads++; throw new Error("unavailable"); });
  await assert.rejects(api.listenTailcat({ identity: { publicKey: `ed25519:${"1".repeat(64)}` }, allowedClients: [] }),error => error.code === "invalid_argument");
  assert.equal(loads,0);
});

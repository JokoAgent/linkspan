import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("the browser runtime has a real, separate WASM artifact with no native code", async () => {
  const bytes = await readFile(new URL("../dist/runtime/linkspan_iroh_bg.wasm",import.meta.url));
  assert.deepEqual([...bytes.subarray(0,4)],[0,97,115,109]);
  assert.equal(WebAssembly.validate(bytes),true);
});

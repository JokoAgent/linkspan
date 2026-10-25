import assert from "node:assert/strict";
import test from "node:test";
import { LinkspanError, asLinkspanError, createOperationScope } from "../dist/index.js";

test("already cancelled and expired work is rejected before effects", async () => {
  const cancellation = new AbortController();
  cancellation.abort();
  const aborted = createOperationScope({ signal: cancellation.signal });
  assert.throws(() => aborted.check(), { code: "cancelled" });
  await assert.rejects(aborted.wait(Promise.resolve("late")), { code: "cancelled" });
  aborted.dispose();
  const expired = createOperationScope({ deadline: Date.now() - 1 });
  assert.throws(() => expired.check(), { code: "deadline_exceeded" });
  expired.dispose();
});

test("pending work is interrupted by the absolute deadline", async () => {
  const scope = createOperationScope({ deadline: Date.now() + 20 });
  try { await assert.rejects(scope.wait(new Promise(() => {})), { code: "deadline_exceeded" }); }
  finally { scope.dispose(); }
});

test("a deadline remains a deadline when an operation lifetime is nested", async () => {
  const parent = createOperationScope({ deadline: Date.now() + 20 });
  const child = createOperationScope({ signal: parent.signal });
  try {
    await assert.rejects(child.wait(new Promise(() => {})), { code: "deadline_exceeded" });
    assert.equal(child.signal.reason.cause, parent.signal.reason);
  } finally { child.dispose(); parent.dispose(); }
});

test("cancellation listeners are removed on success and disposal", async () => {
  const cancellation = new AbortController();
  let attached = 0;
  const add = cancellation.signal.addEventListener.bind(cancellation.signal);
  const remove = cancellation.signal.removeEventListener.bind(cancellation.signal);
  cancellation.signal.addEventListener = (...args) => { attached++; return add(...args); };
  cancellation.signal.removeEventListener = (...args) => { attached--; return remove(...args); };
  const scope = createOperationScope({ signal: cancellation.signal, deadline: Date.now() + 10_000 });
  assert.equal(await scope.wait(Promise.resolve(7)), 7);
  assert.equal(attached, 1);
  scope.dispose();
  scope.dispose();
  assert.equal(attached, 0);
});

test("errors retain stable codes and do not expose transport messages", () => {
  const secret = new Error("sensitive upstream message");
  const error = asLinkspanError(secret);
  assert.equal(error.code, "transport_error");
  assert.equal(error.message.includes("sensitive"), false);
  assert.equal(error.cause, secret);
  assert.equal(asLinkspanError(error), error);
  assert.throws(() => createOperationScope({ deadline: Infinity }), LinkspanError);
});

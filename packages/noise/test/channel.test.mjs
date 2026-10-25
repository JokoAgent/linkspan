import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { createIdentity, identityFromPrivateKey, connectWebSocket, acceptWebSocket, MAX_MESSAGE_BYTES, RECEIVE_WINDOW_BYTES } from "../dist/index.js";

const text = (value) => new TextEncoder().encode(value);
const readText = (value) => new TextDecoder().decode(value);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  promise.catch(() => {});
  return { promise, resolve, reject };
};

async function fixture(t, options = {}) {
  const identity = await createIdentity();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 128 * 1024, perMessageDeflate: false });
  await once(server, "listening");
  const accepted = deferred();
  const channels = [];
  server.on("connection", (socket) => {
    acceptWebSocket(socket, { identity, deadline: Date.now() + 2_000 }).then((channel) => {
      channels.push(channel);
      accepted.resolve(channel);
    }, accepted.reject);
  });
  t.after(async () => {
    for (const channel of channels) channel.abort();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    server, identity, accepted: accepted.promise,
    url: `ws://127.0.0.1:${server.address().port}/linkspan`,
    async connect(overrides = {}) {
      const channel = await connectWebSocket({
        url: this.url, expectedPublicKey: identity.publicKey,
        createSocket: (url) => new WebSocket(url, { perMessageDeflate: false }),
        ...options, ...overrides,
      });
      channels.push(channel);
      return channel;
    },
  };
}

test("real endpoints authenticate, preserve binary boundaries, and exchange orderly close", async (t) => {
  const setup = await fixture(t);
  // Use the platform WebSocket client, not ws, for this first interoperability case.
  const client = await setup.connect({ createSocket: (url) => new globalThis.WebSocket(url) });
  const server = await setup.accepted;
  assert.equal(client.remotePublicKey, setup.identity.publicKey);
  assert.match(server.remotePublicKey, /^ed25519:[0-9a-f]{64}$/);
  const restored = await identityFromPrivateKey(setup.identity.privateKey);
  assert.deepEqual(restored, setup.identity);
  const payload = Uint8Array.from({ length: MAX_MESSAGE_BYTES }, (_, index) => index % 251);
  await client.send(payload);
  assert.deepEqual(await server.receive(), payload);
  await server.send(text("a response through the same endpoint"));
  assert.equal(readText(await client.receive()), "a response through the same endpoint");
  await client.send(new Uint8Array());
  assert.deepEqual(await server.receive(), new Uint8Array());
  await client.send(text("the final message survives close"));
  const closing = client.close();
  assert.equal(readText(await server.receive()), "the final message survives close");
  assert.equal(await server.receive(), null);
  await closing;
  assert.deepEqual(await client.closed, {});
  assert.deepEqual(await server.closed, {});
});

test("a substituted endpoint fails before an application channel is returned", async (t) => {
  const setup = await fixture(t);
  const wrong = await createIdentity();
  await assert.rejects(setup.connect({ expectedPublicKey: wrong.publicKey }), { code: "identity_mismatch" });
  await assert.rejects(setup.accepted);
});

test("pins, malformed identities, and unsafe carrier addresses are rejected before socket creation", async () => {
  let sockets = 0;
  const identity = await createIdentity();
  const createSocket = () => { sockets++; throw new Error("must not be called"); };
  await assert.rejects(connectWebSocket({ url: "wss://example.invalid/", expectedPublicKey: "short fingerprint", createSocket }), { code: "invalid_argument" });
  await assert.rejects(connectWebSocket({ url: "ws://example.invalid/", expectedPublicKey: identity.publicKey, createSocket }), { code: "invalid_argument" });
  await assert.rejects(connectWebSocket({ url: "wss://user:secret@example.invalid/", expectedPublicKey: identity.publicKey, createSocket }), { code: "invalid_argument" });
  await assert.rejects(identityFromPrivateKey(new Uint8Array(68)), { code: "invalid_argument" });
  assert.equal(sockets, 0);
});

test("a host-approved non-loopback WS carrier still authenticates the pinned application endpoint", async (t) => {
  const setup = await fixture(t);
  let socketUrl;
  const client = await setup.connect({
    url: "ws://192.168.23.42:4318/linkspan",
    allowInsecureWebSocket: true,
    createSocket: (url) => { socketUrl = url; return new WebSocket(setup.url); },
  });
  const server = await setup.accepted;
  assert.equal(socketUrl, "ws://192.168.23.42:4318/linkspan");
  assert.equal(client.remotePublicKey, setup.identity.publicKey);
  await client.send(text("private LAN application bytes"));
  assert.equal(readText(await server.receive()), "private LAN application bytes");
  const wrong = await createIdentity();
  await assert.rejects(setup.connect({
    url: "ws://192.168.23.42:4318/linkspan",
    allowInsecureWebSocket: true,
    expectedPublicKey: wrong.publicKey,
    createSocket: () => new WebSocket(setup.url),
  }), { code: "identity_mismatch" });
  for (const url of ["https://192.168.23.42:4318/", "ws://u:p@192.168.23.42:4318/", "ws://192.168.23.42:4318/#fragment"]) {
    await assert.rejects(connectWebSocket({ url, expectedPublicKey: setup.identity.publicKey, allowInsecureWebSocket: true }), { code: "invalid_argument" });
  }
});

test("handshake deadline cancels and closes a real carrier that never authenticates", async (t) => {
  const identity = await createIdentity();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await once(server, "listening");
  const dropped = deferred();
  server.on("connection", (socket) => socket.on("close", dropped.resolve));
  t.after(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  await assert.rejects(connectWebSocket({
    url: `ws://127.0.0.1:${server.address().port}`,
    expectedPublicKey: identity.publicKey,
    deadline: Date.now() + 40,
    createSocket: (url) => new WebSocket(url),
  }), { code: "deadline_exceeded" });
  await dropped.promise;
});

test("cancelling a receive leaves the next authenticated message available", async (t) => {
  const setup = await fixture(t);
  const client = await setup.connect();
  const server = await setup.accepted;
  const cancellation = new AbortController();
  const pending = server.receive({ signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(pending, { code: "cancelled" });
  await client.send(text("retained after receive cancellation"));
  assert.equal(readText(await server.receive()), "retained after receive cancellation");
  const receiving = server.receive({ deadline: Date.now() + 30 });
  await assert.rejects(server.receive(), { code: "invalid_argument" });
  await assert.rejects(receiving, { code: "deadline_exceeded" });
});

test("authenticated credit applies backpressure and cancellation releases queued sends", async (t) => {
  const setup = await fixture(t);
  const client = await setup.connect();
  const server = await setup.accepted;
  const payload = new Uint8Array(MAX_MESSAGE_BYTES).fill(91);
  for (let index = 0; index < 3; index++) await client.send(payload);
  await assert.rejects(client.send(payload, { deadline: Date.now() + 30 }), { code: "deadline_exceeded", outcome: "not_sent" });
  // The cancelled queued send must not be replayed when receive credit arrives.
  assert.deepEqual(await server.receive(), payload);
  await client.send(text("after credit is returned"));
  assert.deepEqual(await server.receive(), payload);
  assert.deepEqual(await server.receive(), payload);
  assert.equal(readText(await server.receive()), "after credit is returned");
  await assert.rejects(server.receive({ deadline: Date.now() + 20 }), { code: "deadline_exceeded" });
  await assert.rejects(client.send(new Uint8Array(MAX_MESSAGE_BYTES + 1)), { code: "invalid_argument", outcome: "not_sent" });
});

test("a native carrier without bufferedAmount authenticates and bounds carrier writes by peer credit", async (t) => {
  const setup = await fixture(t);
  let carrierBytes = 0;
  const client = await setup.connect({ createSocket: (url) => new Proxy(new WebSocket(url), {
    get(target, key) {
      if (key === "bufferedAmount") return undefined;
      if (key === "send") return bytes => { carrierBytes += bytes.byteLength; target.send(bytes); };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) });
  const server = await setup.accepted;
  assert.equal(client.remotePublicKey, setup.identity.publicKey);
  const afterHandshake = carrierBytes;
  const payload = new Uint8Array(MAX_MESSAGE_BYTES).fill(73);
  for (let index = 0; index < 3; index++) await client.send(payload);
  const exhausted = carrierBytes;
  assert.ok(exhausted - afterHandshake < RECEIVE_WINDOW_BYTES);
  // No application receive has returned peer credit. A slow native queue cannot
  // accumulate further payloads merely because it omits bufferedAmount.
  await assert.rejects(client.send(payload, { deadline: Date.now() + 40 }), { code: "deadline_exceeded", outcome: "not_sent" });
  assert.equal(carrierBytes, exhausted);
  assert.deepEqual(await server.receive(), payload);
  await client.send(text("credit returned after the native carrier delivered bytes"));
  assert.deepEqual(await server.receive(), payload);
  assert.deepEqual(await server.receive(), payload);
  assert.equal(readText(await server.receive()), "credit returned after the native carrier delivered bytes");
  await server.send(text("the native response"));
  assert.equal(readText(await client.receive()), "the native response");
  await client.close();
  assert.equal(await server.receive(), null);
  assert.deepEqual(await client.closed, {});
});

test("the send queue rejects excess concurrent bytes instead of retaining an unbounded backlog", async (t) => {
  const setup = await fixture(t);
  const client = await setup.connect();
  await setup.accepted;
  const payload = new Uint8Array(MAX_MESSAGE_BYTES);
  for (let index = 0; index < 3; index++) await client.send(payload);
  const pending = Array.from({ length: 3 }, () => client.send(payload, { deadline: Date.now() + 50 }));
  const observed = Promise.allSettled(pending);
  await assert.rejects(client.send(payload), { code: "resource_exhausted", outcome: "not_sent" });
  for (const result of await observed) assert.equal(result.reason.code, "deadline_exceeded");
});

test("carrier backpressure keeps a cancelled dispatched send outcome unknown and preserves ordering", async (t) => {
  const setup = await fixture(t);
  let blocked = false;
  const client = await setup.connect({ createSocket: (url) => {
    const socket = new WebSocket(url);
    return new Proxy(socket, {
      get(target, key) {
        if (key === "bufferedAmount" && blocked) return 1024 * 1024;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, key, value) { return Reflect.set(target, key, value, target); },
    });
  } });
  const server = await setup.accepted;
  await client.send(text("establish initial credit"));
  await server.receive();
  blocked = true;
  await assert.rejects(client.send(text("dispatched before cancellation"), { deadline: Date.now() + 30 }), { code: "deadline_exceeded", outcome: "unknown" });
  blocked = false;
  // Once ciphertext enters a transport, cancelling the wait cannot retract it.
  assert.equal(readText(await server.receive({ deadline: Date.now() + 1_000 })), "dispatched before cancellation");
  await client.send(text("ordered next message"));
  assert.equal(readText(await server.receive()), "ordered next message");
});

for (const [name, socketFactory] of [
  ["ws", (url) => new WebSocket(url)],
  ["platform WebSocket", (url) => new globalThis.WebSocket(url)],
]) test(`the owning cancellation signal retires both endpoints using ${name}`, { timeout: 2_000 }, async (t) => {
  const cancellation = new AbortController();
  const setup = await fixture(t, { signal: cancellation.signal });
  const client = await setup.connect({ createSocket: socketFactory });
  const server = await setup.accepted;
  cancellation.abort();
  assert.equal((await client.closed).error.code, "cancelled");
  await assert.rejects(client.send(text("must not leave this endpoint")), { code: "cancelled" });
  assert.equal((await server.closed).error.code, "transport_error");
});

test("a normal carrier close without the encrypted close record is truncation", async (t) => {
  const setup = await fixture(t);
  let raw;
  const client = await setup.connect({ createSocket: (url) => { raw = new WebSocket(url); return raw; } });
  const server = await setup.accepted;
  raw.close(1000);
  assert.equal((await server.closed).error.code, "transport_error");
  assert.equal((await client.closed).error.code, "transport_error");
  await assert.rejects(server.receive(), { code: "transport_error" });
});

test("an active forwarding MITM sees ciphertext and cannot tamper with application bytes", async (t) => {
  const setup = await fixture(t);
  const relay = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 128 * 1024, perMessageDeflate: false });
  await once(relay, "listening");
  let mutate = false;
  const observed = [];
  const upstreams = [];
  relay.on("connection", (downstream) => {
    const upstream = new WebSocket(setup.url, { perMessageDeflate: false });
    upstreams.push(upstream);
    const waiting = [];
    const forward = (data) => {
      const ciphertext = Buffer.from(data);
      observed.push(Buffer.from(ciphertext));
      if (mutate) { mutate = false; ciphertext[ciphertext.length - 1] ^= 1; }
      upstream.send(ciphertext);
    };
    downstream.on("message", (data) => upstream.readyState === 1 ? forward(data) : waiting.push(Buffer.from(data)));
    upstream.on("open", () => { for (const data of waiting) forward(data); waiting.length = 0; });
    upstream.on("message", (data) => { if (downstream.readyState === 1) downstream.send(data); });
    upstream.on("error", () => downstream.terminate());
    upstream.on("close", () => downstream.terminate());
    downstream.on("close", () => upstream.terminate());
  });
  t.after(async () => {
    for (const socket of upstreams) socket.terminate();
    for (const socket of relay.clients) socket.terminate();
    await new Promise((resolve) => relay.close(resolve));
  });
  const client = await setup.connect({ url: `ws://127.0.0.1:${relay.address().port}/linkspan` });
  const server = await setup.accepted;
  const secret = "business-bearer-only-after-the-verified-handshake";
  await client.send(text(secret));
  assert.equal(readText(await server.receive()), secret);
  assert.equal(Buffer.concat(observed).includes(Buffer.from(secret)), false);
  // Wait until the initial client credit and first DATA have traversed the relay.
  await server.send(text("synchronized"));
  assert.equal(readText(await client.receive()), "synchronized");
  mutate = true;
  await client.send(text("this ciphertext is modified by the relay"));
  assert.equal((await server.closed).error.code, "authentication_failed");
  await assert.rejects(server.receive(), { code: "authentication_failed" });
});

test("the distributable excludes WASM, native providers, and undeclared runtime imports", async () => {
  const metadata = JSON.parse(await readFile(new URL("../dist/build-meta.json", import.meta.url), "utf8"));
  assert.equal(Object.keys(metadata.inputs).some((input) => /\.wasm$|as-chacha20poly1305|as-sha256|crypto\/index\.js$/.test(input) && input.includes("@chainsafe")), false);
  for (const output of Object.values(metadata.outputs)) {
    assert.deepEqual(output.imports.filter((entry) => entry.path !== "@jokoagent/linkspan-core"), []);
  }
  const bundle = await readFile(new URL("../dist/index.js", import.meta.url), "utf8");
  assert.equal(bundle.includes("WebAssembly"), false);
  assert.equal(bundle.includes("node:crypto"), false);
  assert.equal(bundle.includes("Promise.withResolvers"), false);
});

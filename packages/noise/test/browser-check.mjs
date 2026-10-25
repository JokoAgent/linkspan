// Optional actual-browser integration check. Install playwright-core outside the
// release runtime, then provide LINKSPAN_BROWSER_DRIVER as its absolute entry.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import WebSocket, { WebSocketServer } from "ws";
import { acceptWebSocket, createIdentity } from "../dist/index.js";
import { serveHttp } from "../../http/dist/node.js";

if (!process.env.LINKSPAN_BROWSER_DRIVER) throw new Error("Set LINKSPAN_BROWSER_DRIVER to an installed playwright-core entry file");
const { chromium } = await import(pathToFileURL(process.env.LINKSPAN_BROWSER_DRIVER).href);
const identity = await createIdentity();
const wrongIdentity = await createIdentity();
const secret = "Bearer browser-private-application-secret";
const blob = new Uint8Array(4 * 1024 * 1024).fill(137);
const digest = createHash("sha256").update(blob).digest("hex");
let applicationRequests = 0;
let resolveBackendClosed;
const backendClosed = new Promise((resolve) => { resolveBackendClosed = resolve; });
const backend = createServer(async (request, response) => {
  applicationRequests++;
  try {
    assert.equal(request.headers.authorization, secret);
    if (request.url === "/v1/upload") {
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of request) { hash.update(chunk); bytes += chunk.byteLength; }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ bytes, digest: hash.digest("hex") }));
    } else if (request.url === "/v1/download") {
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": blob.byteLength });
      response.end(blob);
    } else if (request.url === "/v1/events") {
      response.writeHead(200);
      response.write("ready");
      response.once("close", resolveBackendClosed);
    } else { response.writeHead(404); response.end(); }
  } catch { response.destroy(); }
});
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const localOrigin = `http://127.0.0.1:${backend.address().port}`;
const clientPage = `<!doctype html><meta charset="utf-8"><title>Linkspan browser check</title>
<script type="importmap">{"imports":{"@jokoagent/linkspan-core":"/core/index.js"}}</script>
<button id="connect">Connect selected path</button>
<script type="module">
window.modulesLoaded = false;
document.querySelector('#connect').onclick = async () => {
  window.noise = await import('/noise/index.js');
  window.http = await import('/http/index.js');
  window.modulesLoaded = true;
};
</script>`;
const staticFiles = new Map([
  ["/core/index.js", new URL("../../core/dist/index.js", import.meta.url)],
  ["/noise/index.js", new URL("../dist/index.js", import.meta.url)],
  ["/http/index.js", new URL("../../http/dist/index.js", import.meta.url)],
  ["/http/wire.js", new URL("../../http/dist/wire.js", import.meta.url)],
  ["/http/fetch-body.js", new URL("../../http/dist/fetch-body.js", import.meta.url)],
]);
const outer = createServer(async (request, response) => {
  if (request.url === "/") { response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" }); response.end(clientPage); return; }
  const source = staticFiles.get(request.url);
  if (!source) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
  response.end(await readFile(source));
});
const endpoint = new WebSocketServer({ server: outer, maxPayload: 128 * 1024, perMessageDeflate: false });
const channels = [];
const tasks = new Set();
endpoint.on("connection", (socket) => {
  const task = acceptWebSocket(socket, { identity }).then((channel) => {
    channels.push(channel);
    return serveHttp(channel, { origin: localOrigin });
  }).catch(() => {});
  tasks.add(task);
  task.finally(() => tasks.delete(task));
});
await new Promise((resolve) => outer.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${outer.address().port}`;
const relay = new WebSocketServer({ host: "127.0.0.1", port: 0, maxPayload: 128 * 1024, perMessageDeflate: false });
await once(relay, "listening");
const relayUrl = `ws://127.0.0.1:${relay.address().port}/linkspan`;
const upstreams = [];
const ciphertexts = [];
let mutate = false;
relay.on("connection", (downstream) => {
  const upstream = new WebSocket(origin.replace("http:", "ws:"));
  upstreams.push(upstream);
  const queued = [];
  const forward = (data) => {
    const bytes = Buffer.from(data);
    ciphertexts.push(Buffer.from(bytes));
    if (mutate) { mutate = false; bytes[bytes.byteLength - 1] ^= 1; }
    upstream.send(bytes);
  };
  downstream.on("message", (data) => upstream.readyState === 1 ? forward(data) : queued.push(Buffer.from(data)));
  upstream.on("open", () => { for (const data of queued) forward(data); queued.length = 0; });
  upstream.on("message", (data) => { if (downstream.readyState === 1) downstream.send(data); });
  downstream.on("close", () => upstream.terminate());
  upstream.on("close", () => downstream.terminate());
  upstream.on("error", () => downstream.terminate());
});
const executablePath = process.env.LINKSPAN_BROWSER_EXECUTABLE;
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
try {
  const page = await browser.newPage();
  const requests = [];
  const sockets = [];
  page.on("request", (request) => requests.push({ url: request.url(), headers: request.headers() }));
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.goto(origin);
  assert.equal(await page.evaluate(() => window.modulesLoaded), false);
  assert.equal(requests.some(({ url }) => url.includes("/noise/") || url.endsWith(".wasm")), false);
  await page.click("#connect");
  await page.waitForFunction(() => window.modulesLoaded === true);
  const results = await page.evaluate(async ({ origin, relayUrl, publicKey, secret }) => {
    const client = window.http.createHttpFetch({
      origin,
      connect: (options) => window.noise.connectWebSocket({ url: relayUrl, expectedPublicKey: publicKey, ...options }),
    });
    const upload = await client(`${origin}/v1/upload`, { method: "PUT", headers: { authorization: secret }, body: new Uint8Array(4 * 1024 * 1024).fill(137) });
    const uploaded = await upload.json();
    const downloaded = new Uint8Array(await (await client(`${origin}/v1/download`, { headers: { authorization: secret } })).arrayBuffer());
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", downloaded));
    const controller = new AbortController();
    const streaming = await client(`${origin}/v1/events`, { headers: { authorization: secret }, signal: controller.signal });
    const reader = streaming.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    controller.abort();
    let cancelled = false;
    try { await reader.read(); } catch { cancelled = true; }
    return { uploaded, downloadedBytes: downloaded.byteLength, downloadDigest: Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join(""), first, cancelled };
  }, { origin, relayUrl, publicKey: identity.publicKey, secret });
  assert.deepEqual(results.uploaded, { bytes: blob.byteLength, digest });
  assert.equal(results.downloadedBytes, blob.byteLength);
  assert.equal(results.downloadDigest, digest);
  assert.equal(results.first, "ready");
  assert.equal(results.cancelled, true);
  await Promise.race([backendClosed, new Promise((_, reject) => setTimeout(() => reject(new Error("Browser abort left the backend response alive")), 3_000))]);
  const before = applicationRequests;
  const wrongKeyRejected = await page.evaluate(async ({ origin, relayUrl, key }) => {
    try { await window.noise.connectWebSocket({ url: relayUrl, expectedPublicKey: key }); return false; }
    catch (error) { return error.code === "identity_mismatch"; }
  }, { origin, relayUrl, key: wrongIdentity.publicKey });
  assert.equal(wrongKeyRejected, true);
  assert.equal(applicationRequests, before);
  const ciphertext = Buffer.concat(ciphertexts);
  assert.equal(ciphertext.includes(Buffer.from(secret)), false);
  assert.equal(requests.some(({ url }) => url.endsWith(".wasm") || /cloudflare|ngrok|iroh|\.node(?:$|\?)/.test(url)), false);
  assert.equal(requests.some(({ url, headers }) => url.includes("/v1/") || headers.authorization !== undefined), false);
  assert.equal(requests.filter(({ url }) => url.endsWith("/noise/index.js")).length, 1);
  // Corrupt the next new handshake in an active relay. No application request
  // may be dispatched as a result of the failed authenticated exchange.
  mutate = true;
  const tamperingRejected = await page.evaluate(async ({ relayUrl, key }) => {
    try { await window.noise.connectWebSocket({ url: relayUrl, expectedPublicKey: key, deadline: Date.now() + 2_000 }); return false; }
    catch { return true; }
  }, { relayUrl, key: identity.publicKey });
  assert.equal(tamperingRejected, true);
  assert.equal(applicationRequests, before);
  console.log(JSON.stringify({ browser: await browser.version(), endpoint: "browser WebSocket -> untrusted forwarding relay -> Noise -> loopback HTTP", uploadedBytes: blob.byteLength, downloadedBytes: blob.byteLength, digest, cancellationRetiredBackend: true, wrongKeyRejected, tamperingRejected, lazyModuleRequests: requests.map(({ url }) => new URL(url).pathname), carrierConnections: sockets.length, plaintextBusinessNetworkRequests: 0, wasmRequests: 0 }));
} finally {
  await browser.close();
  for (const channel of channels) channel.abort();
  for (const socket of upstreams) socket.terminate();
  for (const socket of relay.clients) socket.terminate();
  for (const socket of endpoint.clients) socket.terminate();
  await new Promise((resolve) => relay.close(resolve));
  await new Promise((resolve) => endpoint.close(resolve));
  await new Promise((resolve) => outer.close(resolve));
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
  await Promise.all(tasks);
}

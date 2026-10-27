import { X509Certificate } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { createServer, isIP, type Server, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { connect as connectTls } from "node:tls";
import { createOperationScope, LinkspanError } from "@jokoagent/linkspan-core";
import { CONNECTOR_LIMITS } from "./limits.js";
import type { CarrierBudget, Connector, ConnectorConfig, ConnectorOptions, ConnectorResource } from "./types.js";

export function invalid(message: string): never { throw new LinkspanError("invalid_argument", message); }
export function boundedText(value: string, name: string, maximum = 4096): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || /[\x00\r\n]/u.test(value)) invalid(`A bounded ${name} is required.`);
  return value;
}
export function publicOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { return invalid("A public HTTPS origin is required."); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== value.replace(/\/$/u, "")) invalid("A public HTTPS origin is required.");
  return url.origin;
}
export function validateBudget(budget: CarrierBudget): void {
  if (!budget || typeof budget.paidEnabled !== "boolean" || !Number.isSafeInteger(budget.maximumBytes) || budget.maximumBytes < 1024 || !Number.isSafeInteger(budget.maximumSessionMs) || budget.maximumSessionMs < 1000 || budget.maximumSessionMs > 86_400_000) invalid("Explicit carrier consent and bounded session time/traffic are required.");
}
export type OriginBridgeMode = "http" | "tls" | "stream";
export function validateOptions(options: ConnectorOptions, mode: OriginBridgeMode = "tls"): URL {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.requestId)) invalid("A stable bounded host request identity is required.");
  if (!Number.isSafeInteger(options.startupTimeoutMs ?? 60_000) || (options.startupTimeoutMs ?? 60_000) < 1000 || (options.startupTimeoutMs ?? 60_000) > 180_000) invalid("The connector startup timeout is outside its supported bounds.");
  if (mode === "stream") {
    const target = options.encryptedStreamTarget;
    if (!target || !["127.0.0.1", "::1"].includes(target.address) || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535
      || options.localOrigin !== undefined || options.originServerName !== undefined || options.originCaPool !== undefined) invalid("The selected stream carrier requires only a fixed literal-loopback Noise target.");
    return new URL(`tcp://${target.address === "::1" ? "[::1]" : target.address}:${target.port}`);
  }
  if (options.encryptedStreamTarget !== undefined) invalid("A raw encrypted stream target is available only for the selected tcpmux carrier.");
  let url: URL;
  if (typeof options.localOrigin !== "string") invalid("An encrypted HTTPS loopback carrier is required.");
  try { url = new URL(options.localOrigin); } catch { return invalid("An encrypted HTTPS loopback carrier is required."); }
  if (url.protocol !== "https:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.origin !== options.localOrigin.replace(/\/$/u, "")) invalid("An encrypted HTTPS loopback carrier is required.");
  const name = options.originServerName;
  if (typeof name !== "string" || name.length > 253 || (isIP(name) === 0 && !name.split(".").every(label => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/u.test(label)))) invalid("A fixed origin certificate identity is required.");
  return url;
}
export async function readCertificateBundle(path: string | undefined): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path)) invalid("An absolute public origin CA file is required.");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 65_536) throw new Error();
    const value = await readFile(path, "utf8");
    const certs = value.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu);
    if (!certs || certs.length > 16 || value.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, "").trim()) throw new Error();
    for (const certificate of certs) new X509Certificate(certificate);
    return `${certs.join("\n")}\n`;
  } catch { return invalid("The origin trust file must contain bounded public PEM certificates only."); }
}

export interface OriginBridge {
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly address: string;
  readonly origin: string;
  readonly exhausted: Promise<void>;
  close(): Promise<void>;
}

/** Fixed-target byte forwarding. L7 carriers receive HTTP and the bridge verifies
 * the host TLS itself. L4 carriers pass the visitor's TLS directly to the host.
 * Explicit stream mode forwards only to the independently pinned Noise listener.
 * No URL, Host header, SDK request or remote control message selects a target. */
export async function createOriginBridge(options: ConnectorOptions, budget: CarrierBudget, mode: OriginBridgeMode): Promise<OriginBridge> {
  const origin = validateOptions(options, mode);
  validateBudget(budget);
  const ca = mode === "stream" ? undefined : await readCertificateBundle(options.originCaPool);
  const sockets = new Set<Socket>();
  let bytes = 0;
  let exhausted = false;
  let resolveExhausted!: () => void;
  const exhaustedPromise = new Promise<void>(resolve => { resolveExhausted = resolve; });
  const count = (chunk: Buffer): void => {
    bytes += chunk.byteLength;
    if (!exhausted && bytes > budget.maximumBytes) {
      exhausted = true;
      for (const socket of sockets) socket.destroy();
      resolveExhausted();
    }
  };
  const track = (socket: Socket): void => {
    sockets.add(socket); socket.setNoDelay(true);
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", count);
    socket.on("error", () => {});
  };
  const server = createServer({ allowHalfOpen: true, pauseOnConnect: true }, incoming => {
    if (exhausted) { incoming.destroy(); return; }
    track(incoming);
    const connectOptions = { host: origin.hostname.replace(/^\[|\]$/gu, ""), port: Number(origin.port), allowHalfOpen: true };
    const outgoing = mode === "http"
      ? connectTls({ ...connectOptions, servername: options.originServerName!, ca: ca!, rejectUnauthorized: true, ALPNProtocols: ["http/1.1"] })
      : importSocket(connectOptions);
    track(outgoing);
    outgoing.once(mode === "http" ? "secureConnect" : "connect", () => {
      incoming.pipe(outgoing); outgoing.pipe(incoming); incoming.resume();
    });
    incoming.once("close", () => outgoing.destroy());
    outgoing.once("error", () => incoming.destroy());
    outgoing.once("close", () => incoming.destroy());
  });
  server.maxConnections = 128;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new LinkspanError("unavailable", "The fixed origin bridge could not bind."); }
  server.on("error", () => { for (const socket of sockets) socket.destroy(); resolveExhausted(); });
  let closePromise: Promise<void> | undefined;
  return { host: "127.0.0.1", port: address.port, address: `127.0.0.1:${address.port}`, origin: `${mode === "http" ? "http" : "tcp"}://127.0.0.1:${address.port}`, exhausted: exhaustedPromise,
    close() { closePromise ??= new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }); return closePromise; } };
}
import { connect as importSocket } from "node:net";

export interface StartedCarrier {
  readonly publicOrigin: string;
  readonly resource: ConnectorResource;
  readonly closed: Promise<unknown>;
  close(): Promise<void>;
}

const liveCarriers = new Map<string, { readonly resource: ConnectorResource; readonly close: () => Promise<void> }>();
const resourceKey = (resource: ConnectorResource): string => `${resource.provider}:${resource.requestId}:${resource.id}`;

/** Never terminate a process from its PID. Same-process leases are closed using
 * their actual owner handle. After restart, transient remote listeners retire
 * only after their owning process is confirmed absent. Persistent cloud
 * resources need their provider-specific ownership lookup/cleanup API. */
export async function reconcileConnectorResource(config: ConnectorConfig, resource: ConnectorResource, options: { readonly requestId: string; readonly signal?: AbortSignal; readonly deadline?: number }): Promise<{ readonly state: "retired" | "outcome_unknown" }> {
  if (!resource || resource.provider !== config.provider || resource.requestId !== options.requestId || typeof resource.id !== "string" || resource.id.length < 1 || resource.id.length > 2048) invalid("The saved connector resource does not belong to this operation.");
  const scope = createOperationScope(options);
  try {
    scope.check();
    const live = liveCarriers.get(resourceKey(resource));
    if (live) {
      if (live.resource.processId !== resource.processId || live.resource.executableSha256 !== resource.executableSha256) invalid("The saved connector process identity does not match the live owner.");
      await scope.wait(live.close());
      return { state: "retired" };
    }
    if (resource.processId === undefined || !Number.isSafeInteger(resource.processId) || resource.processId < 1 || resource.processId === process.pid) return { state: "outcome_unknown" };
    try { process.kill(resource.processId, 0); return { state: "outcome_unknown" }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { state: "outcome_unknown" };
    }
    // No persistent resource is implicitly removed. These carriers expose only
    // session-bound listeners and do not create reservations/subscriptions.
    if (["ssh", "ngrok", "pinggy", "localtunnel", "frp", "rathole", "bore", "funnel", "pangolin", "netbird", "dev-tunnels"].includes(config.provider)) return { state: "retired" };
    return { state: "outcome_unknown" };
  } finally { scope.dispose(); }
}

/** Owns an SDK result even when cancellation wins while its creation is pending. */
export async function startWithLifecycle(config: ConnectorConfig, options: ConnectorOptions, mode: OriginBridgeMode, start: (bridge: OriginBridge, signal: AbortSignal) => Promise<StartedCarrier>): Promise<Connector> {
  if ((mode === "stream") !== (config.provider === "frp" && config.mode === "tcpmux")) invalid("Only the selected frp tcpmux carrier may use a raw Noise target.");
  validateBudget(config.budget); validateOptions(options, mode);
  const expiry = Math.min(options.deadline ?? Infinity, Date.now() + config.budget.maximumSessionMs);
  const lease = createOperationScope({ ...(options.signal === undefined ? {} : { signal: options.signal }), deadline: expiry });
  lease.check();
  let bridge: OriginBridge;
  try { bridge = await createOriginBridge(options, config.budget, mode); }
  catch (error) { lease.dispose(); throw error; }
  try { lease.check(); } catch (error) { lease.dispose(); await bridge.close(); throw error; }
  const shutdown = new AbortController();
  let carrier: StartedCarrier | undefined;
  let closePromise: Promise<void> | undefined;
  let stopped = false;
  const close = (): Promise<void> => {
    stopped = true;
    shutdown.abort();
    if (closePromise) return closePromise;
    const pending = (async () => {
      lease.dispose(); lease.signal.removeEventListener("abort", onAbort);
      await bridge.close();
      if (carrier) await boundedClose(() => carrier!.close());
      if (carrier && liveCarriers.get(resourceKey(carrier.resource))?.close === close) liveCarriers.delete(resourceKey(carrier.resource));
    })();
    closePromise = pending;
    void pending.catch(() => { if (closePromise === pending) closePromise = undefined; });
    return pending;
  };
  const onAbort = (): void => { void close().catch(() => {}); };
  lease.signal.addEventListener("abort", onAbort, { once: true });
  void bridge.exhausted.then(onAbort);
  const startup = createOperationScope({ signal: lease.signal, deadline: Math.min(expiry, Date.now() + (options.startupTimeoutMs ?? 60_000)) });
  let dispatched = false;
  const attempt = Promise.resolve().then(() => { startup.check(); dispatched = true; return start(bridge, AbortSignal.any([startup.signal, shutdown.signal])); });
  void attempt.then(async late => {
    if (stopped) await boundedClose(() => late.close());
  }).catch(() => {});
  try {
    carrier = await startup.wait(attempt);
    lease.check();
    const origin = publicOrigin(carrier.publicOrigin);
    if (carrier.resource.provider !== config.provider || carrier.resource.requestId !== options.requestId) throw new LinkspanError("protocol_error", "The connector returned an unrelated resource identity.");
    const resource: ConnectorResource = Object.freeze({ ...carrier.resource, processId: carrier.resource.processId ?? process.pid });
    const receipt = options.onResource?.(resource) as unknown;
    if (receipt !== null && typeof receipt === "object" && "then" in receipt) { void Promise.resolve(receipt).catch(() => {}); throw new Error(); }
    liveCarriers.set(resourceKey(resource), { resource, close });
    const closed = carrier.closed.then(async () => { const wasStopped = stopped; await close(); return { reason: wasStopped ? "stopped" as const : "exited" as const }; }, async () => { await close(); return { reason: "exited" as const, error: "The carrier disconnected." }; });
    void closed.catch(() => {});
    return Object.freeze({ kind: config.provider, requestId: options.requestId, publicOrigin: origin, resource, limits: CONNECTOR_LIMITS[config.provider], closed, close });
  } catch (error) {
    await close();
    if (dispatched && carrier === undefined && error instanceof LinkspanError && ["cancelled", "deadline_exceeded"].includes(error.code)) throw new LinkspanError("outcome_unknown", "The carrier creation is still being reconciled after cancellation; its original operation must not be replayed.", { outcome: "unknown" });
    if (error instanceof LinkspanError) throw error;
    throw new LinkspanError("outcome_unknown", "The carrier effect could not be confirmed; reconcile the original host operation before retrying.", { outcome: "unknown" });
  } finally { startup.dispose(); }
}

export async function boundedClose(close: () => Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([close(), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new LinkspanError("outcome_unknown", "Carrier cleanup did not confirm within its bound.", { outcome: "unknown" })), 10_000); })]); }
  catch { throw new LinkspanError("outcome_unknown", "Carrier cleanup is unconfirmed; reconcile the original owned resource before replacement.", { outcome: "unknown" }); }
  finally { if (timer) clearTimeout(timer); }
}

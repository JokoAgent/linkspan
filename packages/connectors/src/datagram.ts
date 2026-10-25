import { spawn } from "node:child_process";
import { createSocket, type Socket, type RemoteInfo } from "node:dgram";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createOperationScope, LinkspanError, type OperationOptions } from "@jokoagent/linkspan-core";
import type { CarrierBudget, ConnectorHelper, ConnectorResource, RatholeConfig } from "./types.js";
import { boundedText, invalid, publicOrigin, readCertificateBundle, validateBudget, boundedClose } from "./runtime.js";
import { verifyConnectorHelper } from "./artifacts.js";

export interface OwnedDatagramTarget {
  /** Literal local interface address, never a relay-supplied forwarding target. */
  readonly address: string;
  readonly port: number;
  /** Host-owned capture/media attempt identity. Linkspan never grants permission. */
  readonly ownerId: string;
}
export interface DatagramBounds {
  readonly maximumDatagramBytes?: number;
  readonly maximumPeers?: number;
  readonly idleTimeoutMs?: number;
}
interface DatagramConfigBase extends DatagramBounds {
  readonly budget: CarrierBudget;
  readonly publicHost: string;
  readonly publicPort: number;
}
export interface NetbirdDatagramConfig extends DatagramConfigBase {
  readonly helper: ConnectorHelper;
  readonly provider: "netbird";
  readonly managementUrl: string;
  readonly setupKey: string;
  readonly stateDirectory: string;
  readonly listenPort: number;
  readonly resourceId: string;
}
export interface PangolinDatagramConfig extends DatagramConfigBase {
  readonly helper: ConnectorHelper;
  readonly provider: "pangolin";
  readonly endpoint: string;
  readonly siteId: string;
  readonly siteSecret: string;
  /** Explicit existing node; Cloud raw forwarding requires a user-owned node. */
  readonly remoteNodeId: string;
}
export interface FrpDatagramConfig extends DatagramConfigBase {
  readonly provider: "frp";
  readonly helper: ConnectorHelper;
  readonly serverAddress: string;
  readonly serverPort: number;
  readonly token: string;
  readonly serverName: string;
  readonly serverCaPool: string;
  readonly remotePort: number;
}
export interface RatholeDatagramConfig extends DatagramConfigBase {
  readonly provider: "rathole";
  readonly helper: ConnectorHelper;
  readonly remoteAddress: string;
  readonly serviceName: string;
  readonly token: string;
  readonly transport: RatholeConfig["transport"];
}
export interface PinggyDatagramConfig extends Omit<DatagramConfigBase, "publicHost" | "publicPort"> {
  readonly provider: "pinggy";
  readonly runtime: "sdk";
  readonly sdkDirectory: string;
  readonly token?: string;
  /** Omit both for a free temporary allocation; supplied pairs must match exactly. */
  readonly publicHost?: string;
  readonly publicPort?: number;
}
export type DatagramConfig = NetbirdDatagramConfig | PangolinDatagramConfig | FrpDatagramConfig | RatholeDatagramConfig | PinggyDatagramConfig;
export interface DatagramMappingOptions extends OperationOptions {
  readonly requestId: string;
  readonly localTarget: OwnedDatagramTarget;
  readonly startupTimeoutMs?: number;
  readonly onResource?: (resource: ConnectorResource) => void;
}
export interface PublishedDatagramMapping {
  readonly protocol: "udp";
  readonly publicHost: string;
  readonly publicPort: number;
  readonly localAddress: string;
  readonly localPort: number;
  readonly ownerId: string;
  readonly requestId: string;
  readonly expiresAt: number;
}
export interface DatagramMapping {
  readonly kind: `${DatagramConfig["provider"]}.udp`;
  readonly mapping: PublishedDatagramMapping;
  readonly resource: ConnectorResource;
  readonly closed: Promise<{ readonly reason: "stopped" | "exited" }>;
  close(): Promise<void>;
}
interface ResolvedBounds { maximumDatagramBytes: number; maximumPeers: number; idleTimeoutMs: number }
const port = (value: number): number => { if (!Number.isInteger(value) || value < 1 || value > 65535) invalid("The UDP relay port is invalid."); return value; };
function relayAddress(value: string): void { boundedText(value, "relay address", 512); if (/[\s/@?#\\]/u.test(value)) invalid("The UDP relay address is invalid."); }
function bounds(input: DatagramBounds): ResolvedBounds {
  const value = { maximumDatagramBytes: input.maximumDatagramBytes ?? 2048, maximumPeers: input.maximumPeers ?? 32, idleTimeoutMs: input.idleTimeoutMs ?? 30_000 };
  if (!Number.isInteger(value.maximumDatagramBytes) || value.maximumDatagramBytes < 256 || value.maximumDatagramBytes > 65_507 || !Number.isInteger(value.maximumPeers) || value.maximumPeers < 1 || value.maximumPeers > 64 || !Number.isInteger(value.idleTimeoutMs) || value.idleTimeoutMs < 1_000 || value.idleTimeoutMs > 120_000) invalid("The UDP datagram, peer and idle limits are invalid.");
  return value;
}
function validateTarget(target: OwnedDatagramTarget): void {
  const family = isIP(target.address);
  if (family === 0 || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) invalid("The media target must be an exact locally owned UDP address and port.");
  const owned = target.address === "127.0.0.1" || target.address === "::1" || Object.values(networkInterfaces()).flat().some(value => value?.address === target.address);
  if (!owned) invalid("A UDP forward may target only an address owned by this host.");
  boundedText(target.ownerId, "original media owner identity", 256);
}
export interface DatagramBridge {
  readonly address: string;
  readonly port: number;
  readonly exhausted: Promise<void>;
  close(): Promise<void>;
}

/** Packet-preserving local bridge. Each remote tuple has its own connected
 * socket to the immutable media target. At most 64 peers and 64 queued packets
 * exist; excess packets are dropped, never concatenated or retried. */
export async function createDatagramBridge(target: OwnedDatagramTarget, budget: CarrierBudget, input: DatagramBounds = {}): Promise<DatagramBridge> {
  validateTarget(target); validateBudget(budget); const limit = bounds(input);
  const receiver = createSocket("udp4");
  const peers = new Map<string, { socket: Socket; address: RemoteInfo; ready: boolean; queue: Buffer[]; last: number }>();
  let closed = false; let total = 0; let pending = 0; let queued = 0; let resolveExhausted!: () => void;
  const exhausted = new Promise<void>(resolve => { resolveExhausted = resolve; });
  let closePromise: Promise<void> | undefined;
  const retire = (key: string): void => { const peer = peers.get(key); if (!peer) return; peers.delete(key); queued -= peer.queue.length; peer.queue.length = 0; try { peer.socket.close(); } catch {} };
  const close = (): Promise<void> => {
    if (closePromise) return closePromise; closed = true; clearInterval(timer);
    for (const key of peers.keys()) retire(key);
    closePromise = new Promise(resolve => { try { receiver.close(() => resolve()); } catch { resolve(); } });
    return closePromise;
  };
  const count = (packet: Buffer): boolean => {
    if (closed) return false; total += packet.byteLength;
    if (total > budget.maximumBytes) { resolveExhausted(); void close(); return false; }
    return packet.byteLength <= limit.maximumDatagramBytes;
  };
  const send = (peer: { socket: Socket; last: number }, packet: Buffer): void => {
    if (closed || pending >= 64) return; pending++; peer.last = Date.now();
    peer.socket.send(packet, error => { pending--; if (error) { resolveExhausted(); void close(); } });
  };
  receiver.on("message", (packet, remote) => {
    if (!count(packet) || remote.address !== "127.0.0.1") return;
    const key = `${remote.address}:${remote.port}`; let peer = peers.get(key);
    if (!peer) {
      if (peers.size >= limit.maximumPeers || queued >= 64) return;
      const socket = createSocket(isIP(target.address) === 6 ? "udp6" : "udp4");
      peer = { socket, address: remote, ready: false, queue: [], last: Date.now() }; peers.set(key, peer);
      const owned = peer;
      // A failed capture target is terminal for this publication. Never attach
      // a later packet to a different process which reused the same UDP port.
      socket.on("error", () => { resolveExhausted(); void close(); });
      socket.on("message", response => {
        if (peers.get(key) !== owned || !count(response) || pending >= 64) return;
        owned.last = Date.now(); pending++;
        receiver.send(response, owned.address.port, owned.address.address, () => { pending--; });
      });
      socket.connect(target.port, target.address, () => {
        if (closed || peers.get(key) !== owned) return; owned.ready = true;
        for (const packet of owned.queue) { queued--; send(owned, packet); } owned.queue.length = 0;
      });
    }
    peer.last = Date.now();
    if (peer.ready) send(peer, packet);
    else if (peer.queue.length < 4 && queued < 64) { peer.queue.push(packet); queued++; }
  });
  receiver.on("error", () => { resolveExhausted(); void close(); });
  const timer = setInterval(() => { const now = Date.now(); for (const [key, peer] of peers) if (now - peer.last >= limit.idleTimeoutMs) retire(key); }, Math.min(1000, limit.idleTimeoutMs));
  try { await new Promise<void>((resolve, reject) => { receiver.once("error", reject); receiver.bind(0, "127.0.0.1", () => { receiver.removeListener("error", reject); resolve(); }); }); }
  catch (error) { await close(); throw new LinkspanError("unavailable", "The owned UDP bridge could not bind."); }
  const port = receiver.address().port;
  return { address: `127.0.0.1:${port}`, port, exhausted, close };
}

/** Publishes an opaque UDP mapping for an already-authorized same-host media
 * engine. This is neither TURN nor a HTTPS origin. The host binds authenticated
 * SDP/DTLS fingerprints and must abort on capture/attempt revocation. */
export async function startDatagramMapping(config: DatagramConfig, options: DatagramMappingOptions): Promise<DatagramMapping> {
  validateBudget(config.budget); validateTarget(options.localTarget); const limit = bounds({ ...config, maximumDatagramBytes: config.maximumDatagramBytes ?? (config.provider === "frp" ? 1500 : 2048) });
  if (!Number.isSafeInteger(options.startupTimeoutMs ?? 60_000) || (options.startupTimeoutMs ?? 60_000) < 1000 || (options.startupTimeoutMs ?? 60_000) > 180_000) invalid("The UDP startup timeout is outside its supported bounds.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.requestId)) invalid("The public UDP mapping identity is invalid.");
  if (config.provider !== "pinggy" || config.publicHost !== undefined || config.publicPort !== undefined) {
    if (typeof config.publicHost !== "string" || config.publicPort === undefined || !Number.isInteger(config.publicPort) || config.publicPort < 1 || config.publicPort > 65535 || (isIP(config.publicHost) === 0 && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u.test(config.publicHost))) invalid("The public UDP mapping address is invalid.");
  }
  if (config.provider === "netbird") { publicOrigin(config.managementUrl); boundedText(config.setupKey, "dedicated peer setup key"); boundedText(config.resourceId, "owned proxy resource", 128); if (!isAbsolute(config.stateDirectory) || !Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) invalid("The UDP peer state path and listening port are invalid."); }
  else if (config.provider === "pangolin") { publicOrigin(config.endpoint); boundedText(config.siteId, "dedicated site identity", 128); boundedText(config.siteSecret, "dedicated site secret"); boundedText(config.remoteNodeId, "existing raw-forwarding node identity", 128); }
  else if (config.provider === "frp") { relayAddress(config.serverAddress); port(config.serverPort); relayAddress(config.serverName); boundedText(config.token, "relay publisher token"); if (port(config.remotePort) !== config.publicPort) invalid("The frp UDP public port must equal its exact configured relay port."); }
  else if (config.provider === "rathole") { relayAddress(config.remoteAddress); boundedText(config.token, "relay service token"); if (!/^[A-Za-z0-9_-]{1,128}$/u.test(config.serviceName)) invalid("The rathole UDP service identity is invalid."); }
  else if (config.provider === "pinggy") { if (config.runtime !== "sdk" || !isAbsolute(config.sdkDirectory)) invalid("Pinggy UDP requires its explicitly prepared SDK runtime."); if (config.token !== undefined) boundedText(config.token, "publisher tunnel token"); }
  else invalid("The selected provider has no public UDP mapping adapter.");
  const sessionMs = config.provider === "pinggy" && !config.budget.paidEnabled ? Math.min(config.budget.maximumSessionMs, 3_600_000) : config.budget.maximumSessionMs;
  const expiresAt = Math.min(options.deadline ?? Infinity, Date.now() + sessionMs);
  const scope = createOperationScope({ ...(options.signal === undefined ? {} : { signal: options.signal }), deadline: expiresAt }); scope.check();
  if (config.provider === "pinggy") return startPinggyMapping(config, options, limit, expiresAt, scope);
  let helper: ConnectorHelper; let bridge: DatagramBridge; let directory: string;
  try {
    helper = await verifyConnectorHelper(config.provider, config.helper); scope.check();
    bridge = await createDatagramBridge(options.localTarget, config.budget, limit);
    try { directory = await mkdtemp(join(tmpdir(), "linkspan-datagram-")); }
    catch (error) { await bridge.close(); throw error; }
    try { await chmod(directory, 0o700); }
    catch (error) { await bridge.close(); await rm(directory, { recursive: true, force: true }); throw error; }
  } catch (error) { scope.dispose(); throw error; }
  let spawned = false;
  try {
    scope.check(); const file = join(directory, config.provider === "frp" || config.provider === "rathole" ? "config.toml" : "config.json");
    const common = { requestId: options.requestId, mode: "udp", localAddress: bridge.address, publicHost: config.publicHost, publicPort: config.publicPort, ...limit, maximumBytes: config.budget.maximumBytes, expiresAt };
    let args: string[]; let accepts: (line: string) => boolean;
    if (config.provider === "frp") {
      const caFile = join(directory, "relay-ca.pem"); await writeFile(caFile, await readCertificateBundle(config.serverCaPool), { flag: "wx", mode: 0o600 });
      await writeFile(file, `serverAddr = ${JSON.stringify(config.serverAddress)}\nserverPort = ${config.serverPort}\nudpPacketSize = ${limit.maximumDatagramBytes}\nauth.method = "token"\nauth.token = ${JSON.stringify(config.token)}\ntransport.tls.enable = true\ntransport.tls.serverName = ${JSON.stringify(config.serverName)}\ntransport.tls.trustedCaFile = ${JSON.stringify(caFile)}\nwebServer.addr = "127.0.0.1"\nwebServer.port = 0\nlog.to = "console"\nlog.level = "info"\nloginFailExit = true\n[[proxies]]\nname = ${JSON.stringify(`linkspan-${options.requestId}`)}\ntype = "udp"\nlocalIP = "127.0.0.1"\nlocalPort = ${bridge.port}\nremotePort = ${config.remotePort}\n`, { flag: "wx", mode: 0o600 });
      args = ["-c", file]; accepts = line => line.includes("start proxy success");
    } else if (config.provider === "rathole") {
      let transport: string;
      if (config.transport?.type === "noise") {
        if (!/^[A-Za-z0-9+/]{43}=$/u.test(config.transport.remotePublicKey)) invalid("A fixed UDP relay Noise key is required.");
        transport = `[client.transport]\ntype = "noise"\n[client.transport.noise]\nremote_public_key = ${JSON.stringify(config.transport.remotePublicKey)}\n`;
      } else if (config.transport?.type === "tls") {
        relayAddress(config.transport.hostname);
        const caFile = join(directory, "relay-ca.pem"); await writeFile(caFile, await readCertificateBundle(config.transport.trustedRoot), { flag: "wx", mode: 0o600 });
        transport = `[client.transport]\ntype = "tls"\n[client.transport.tls]\nhostname = ${JSON.stringify(config.transport.hostname)}\ntrusted_root = ${JSON.stringify(caFile)}\n`;
      } else return invalid("The UDP connector-to-relay transport must be Noise or verified TLS.");
      await writeFile(file, `[client]\nremote_addr = ${JSON.stringify(config.remoteAddress)}\n${transport}\n[client.services.${config.serviceName}]\ntype = "udp"\ntoken = ${JSON.stringify(config.token)}\nlocal_addr = ${JSON.stringify(bridge.address)}\n`, { flag: "wx", mode: 0o600 });
      args = ["--client", file]; accepts = line => line.includes("Control channel established");
    } else {
      const input = config.provider === "netbird" ? { ...common, managementUrl: config.managementUrl, setupKey: config.setupKey, stateDirectory: config.stateDirectory, listenPort: config.listenPort } : { ...common, endpoint: config.endpoint, siteId: config.siteId, siteSecret: config.siteSecret };
      await writeFile(file, JSON.stringify(input), { flag: "wx", mode: 0o600 });
      args = ["--config", file]; accepts = line => { try { const value = JSON.parse(line) as { type?: string; protocol?: string; publicHost?: string; publicPort?: number }; return value.type === "ready" && value.protocol === "udp" && value.publicHost === config.publicHost && value.publicPort === config.publicPort; } catch { return false; } };
    }
    scope.check();
    const environment: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TMP: directory, TEMP: directory, TMPDIR: directory, RUST_LOG: "info", NO_COLOR: "1" };
    for (const key of ["SystemRoot", "WINDIR"] as const) if (process.env[key] !== undefined) environment[key] = process.env[key];
    const child = spawn(helper.executable, args, { cwd: directory, env: environment, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] }); spawned = true;
    let exited = false; let stopped = false; let resolveExit!: () => void; let rejectReady!: (error: Error) => void; let resolveReady!: () => void;
    const processExit = new Promise<void>(resolve => { resolveExit = resolve; });
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    child.once("close", () => { exited = true; resolveExit(); rejectReady(new LinkspanError("unavailable", "The UDP helper exited before registration.")); });
    child.once("error", () => rejectReady(new LinkspanError("unavailable", "The prepared UDP helper could not start.")));
    const resource: ConnectorResource = Object.freeze({ provider: config.provider, requestId: options.requestId, id: `udp:${options.requestId}`, ...(child.pid === undefined ? {} : { processId: child.pid }), executableSha256: helper.sha256, createdByHost: true });
    let cleanup: Promise<void>; let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      stopped = true;
      closePromise ??= boundedClose(async () => {
        await bridge.close(); if (config.provider === "frp" || config.provider === "rathole") child.kill("SIGTERM"); else child.stdin?.end();
        const kill = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5000);
        try { await processExit; await cleanup; } finally { clearTimeout(kill); }
      });
      return closePromise;
    };
    const abort = (): void => { rejectReady(new LinkspanError("cancelled", "The original UDP mapping was cancelled.")); void close().catch(() => {}); };
    scope.signal.addEventListener("abort", abort, { once: true }); void bridge.exhausted.then(abort);
    const parentExit = (): void => { if (!exited) child.kill("SIGTERM"); };
    process.once("exit", parentExit); process.once("uncaughtExceptionMonitor", parentExit);
    const timer = setTimeout(() => { rejectReady(new LinkspanError("deadline_exceeded", "The UDP helper did not register within its startup bound.")); void close().catch(() => {}); }, options.startupTimeoutMs ?? 60_000);
    cleanup = processExit.then(async () => { scope.dispose(); clearTimeout(timer); scope.signal.removeEventListener("abort", abort); process.removeListener("exit", parentExit); process.removeListener("uncaughtExceptionMonitor", parentExit); await bridge.close(); await rm(directory, { recursive: true, force: true }); }); void cleanup.catch(() => {});
    const observe = (stream: NodeJS.ReadableStream | null) => { let line = ""; let dropping = false;
      stream?.on("data", (data: Buffer) => { for (const character of data.toString("utf8")) { if (character === "\n") {
        if (!dropping && accepts(line)) resolveReady(); line = ""; dropping = false;
      } else if (!dropping) { if (line.length >= 8192) { line = ""; dropping = true; } else line += character; } } });
    };
    observe(child.stdout); observe(child.stderr);
    try {
      const written = options.onResource?.(resource) as unknown; if (written !== null && typeof written === "object" && "then" in written) { void Promise.resolve(written).catch(() => {}); throw new Error(); }
      if (scope.signal.aborted) abort(); await ready; scope.check(); clearTimeout(timer);
    } catch (error) { await close(); throw error; }
    const closed = cleanup.then(() => ({ reason: stopped ? "stopped" as const : "exited" as const }));
    void closed.catch(() => {});
    const mapping = Object.freeze({ protocol: "udp" as const, publicHost: config.publicHost, publicPort: config.publicPort, localAddress: options.localTarget.address, localPort: options.localTarget.port, ownerId: options.localTarget.ownerId, requestId: options.requestId, expiresAt });
    return Object.freeze({ kind: `${config.provider}.udp` as DatagramMapping["kind"], mapping, resource, closed, close });
  } catch (error) {
    if (!spawned) { scope.dispose(); await bridge.close(); await rm(directory, { recursive: true, force: true }); }
    if (error instanceof LinkspanError) throw error;
    throw new LinkspanError("outcome_unknown", "The UDP mapping lifetime could not be confirmed.", { outcome: "unknown" });
  }
}

async function startPinggyMapping(config: PinggyDatagramConfig, options: DatagramMappingOptions, limit: ResolvedBounds, expiresAt: number, scope: ReturnType<typeof createOperationScope>): Promise<DatagramMapping> {
  let preparedBridge: DatagramBridge | undefined;
  try { preparedBridge = await createDatagramBridge(options.localTarget, config.budget, limit); scope.check(); }
  catch (error) { scope.dispose(); await preparedBridge?.close(); throw error; }
  const bridge = preparedBridge;
  type Carrier = { resource: ConnectorResource; publicHost: string; publicPort: number; closed: Promise<void>; close(): Promise<void> };
  let carrier: Carrier | undefined; let stopped = false; let closing: Promise<void> | undefined;
  const shutdown = new AbortController();
  const close = () => closing ??= (async () => {
    stopped = true; shutdown.abort(); scope.signal.removeEventListener("abort", abort); scope.dispose();
    await bridge.close(); if (carrier) await boundedClose(carrier.close);
  })();
  const abort = () => { void close().catch(() => {}); };
  scope.signal.addEventListener("abort", abort, { once: true }); void bridge.exhausted.then(abort);
  const startup = createOperationScope({ signal: scope.signal, deadline: Math.min(expiresAt, Date.now() + (options.startupTimeoutMs ?? 60_000)) });
  let dispatched = false;
  try {
    scope.check();
    const name = "@jokoagent/linkspan-pinggy";
    let backend: { startDatagram(config: PinggyDatagramConfig, options: { requestId: string; localAddress: string; signal: AbortSignal; onResource?: (resource: ConnectorResource) => void }): Promise<Carrier> };
    try { backend = await startup.wait(import(name)); }
    catch (error) { if (startup.signal.aborted) throw error; throw new LinkspanError("unavailable", "Install the explicitly selected Pinggy provider package before enabling its UDP carrier."); }
    startup.check(); dispatched = true;
    const pending = backend.startDatagram(config, { requestId: options.requestId, localAddress: bridge.address, signal: AbortSignal.any([startup.signal, shutdown.signal]),
      ...(options.onResource === undefined ? {} : { onResource: options.onResource }) });
    void pending.then(async late => { if (stopped) await boundedClose(late.close); }).catch(() => {});
    carrier = await startup.wait(pending); scope.check();
    if (carrier.resource.provider !== "pinggy" || carrier.resource.requestId !== options.requestId) throw new LinkspanError("protocol_error", "The UDP carrier returned an unrelated resource identity.");
    const closed = carrier.closed.then(async () => { const wasStopped = stopped; await close(); return { reason: wasStopped ? "stopped" as const : "exited" as const }; }, async () => { await close(); return { reason: "exited" as const }; });
    void closed.catch(() => {});
    const mapping = Object.freeze({ protocol: "udp" as const, publicHost: carrier.publicHost, publicPort: carrier.publicPort, localAddress: options.localTarget.address, localPort: options.localTarget.port, ownerId: options.localTarget.ownerId, requestId: options.requestId, expiresAt });
    return Object.freeze({ kind: "pinggy.udp", mapping, resource: carrier.resource, closed, close });
  } catch (error) {
    await close();
    if (error instanceof LinkspanError && (!dispatched || !["cancelled", "deadline_exceeded"].includes(error.code))) throw error;
    throw new LinkspanError("outcome_unknown", "The Pinggy UDP publication did not confirm; reconcile the original operation before retrying.", { outcome: "unknown" });
  } finally { startup.dispose(); }
}

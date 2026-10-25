import { spawn } from "node:child_process";
import { createSocket, type Socket, type RemoteInfo } from "node:dgram";
import { mkdtemp, chmod, writeFile, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createOperationScope, LinkspanError, type OperationOptions } from "@jokoagent/linkspan-core";
import type { CarrierBudget, ConnectorHelper, ConnectorResource } from "./types.js";
import { boundedText, invalid, publicOrigin, validateBudget, boundedClose } from "./runtime.js";
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
  readonly helper: ConnectorHelper;
  readonly budget: CarrierBudget;
  readonly publicHost: string;
  readonly publicPort: number;
}
export interface NetbirdDatagramConfig extends DatagramConfigBase {
  readonly provider: "netbird";
  readonly managementUrl: string;
  readonly setupKey: string;
  readonly stateDirectory: string;
  readonly listenPort: number;
  readonly resourceId: string;
}
export interface PangolinDatagramConfig extends DatagramConfigBase {
  readonly provider: "pangolin";
  readonly endpoint: string;
  readonly siteId: string;
  readonly siteSecret: string;
  /** Explicit existing node; Cloud raw forwarding requires a user-owned node. */
  readonly remoteNodeId: string;
}
export type DatagramConfig = NetbirdDatagramConfig | PangolinDatagramConfig;
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
  readonly kind: "netbird.udp" | "pangolin.udp";
  readonly mapping: PublishedDatagramMapping;
  readonly resource: ConnectorResource;
  readonly closed: Promise<{ readonly reason: "stopped" | "exited" }>;
  close(): Promise<void>;
}
interface ResolvedBounds { maximumDatagramBytes: number; maximumPeers: number; idleTimeoutMs: number }
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
  validateBudget(config.budget); validateTarget(options.localTarget); const limit = bounds(config);
  if (!Number.isSafeInteger(options.startupTimeoutMs ?? 60_000) || (options.startupTimeoutMs ?? 60_000) < 1000 || (options.startupTimeoutMs ?? 60_000) > 180_000) invalid("The UDP startup timeout is outside its supported bounds.");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.requestId) || !Number.isInteger(config.publicPort) || config.publicPort < 1 || config.publicPort > 65535 || (isIP(config.publicHost) === 0 && !/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/u.test(config.publicHost))) invalid("The public UDP mapping identity or address is invalid.");
  if (config.provider === "netbird") { publicOrigin(config.managementUrl); boundedText(config.setupKey, "dedicated peer setup key"); boundedText(config.resourceId, "owned proxy resource", 128); if (!isAbsolute(config.stateDirectory) || !Number.isInteger(config.listenPort) || config.listenPort < 1 || config.listenPort > 65535) invalid("The UDP peer state path and listening port are invalid."); }
  else if (config.provider === "pangolin") { publicOrigin(config.endpoint); boundedText(config.siteId, "dedicated site identity", 128); boundedText(config.siteSecret, "dedicated site secret"); boundedText(config.remoteNodeId, "existing raw-forwarding node identity", 128); }
  else invalid("The selected provider has no public UDP mapping adapter.");
  const expiresAt = Math.min(options.deadline ?? Infinity, Date.now() + config.budget.maximumSessionMs);
  const scope = createOperationScope({ ...(options.signal === undefined ? {} : { signal: options.signal }), deadline: expiresAt }); scope.check();
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
    scope.check(); const file = join(directory, "config.json");
    const common = { requestId: options.requestId, mode: "udp", localAddress: bridge.address, publicHost: config.publicHost, publicPort: config.publicPort, ...limit, maximumBytes: config.budget.maximumBytes, expiresAt };
    const input = config.provider === "netbird" ? { ...common, managementUrl: config.managementUrl, setupKey: config.setupKey, stateDirectory: config.stateDirectory, listenPort: config.listenPort } : { ...common, endpoint: config.endpoint, siteId: config.siteId, siteSecret: config.siteSecret };
    await writeFile(file, JSON.stringify(input), { flag: "wx", mode: 0o600 }); scope.check();
    const environment: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TMP: directory, TEMP: directory, TMPDIR: directory, NO_COLOR: "1" };
    for (const key of ["SystemRoot", "WINDIR"] as const) if (process.env[key] !== undefined) environment[key] = process.env[key];
    const child = spawn(helper.executable, ["--config", file], { cwd: directory, env: environment, windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"] }); spawned = true;
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
        await bridge.close(); child.stdin?.end();
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
    let line = ""; let dropping = false;
    child.stdout?.on("data", (data: Buffer) => { for (const character of data.toString("utf8")) { if (character === "\n") {
      if (!dropping) try { const value = JSON.parse(line) as { type?: string; protocol?: string; publicHost?: string; publicPort?: number }; if (value.type === "ready" && value.protocol === "udp" && value.publicHost === config.publicHost && value.publicPort === config.publicPort) resolveReady(); } catch {}
      line = ""; dropping = false;
    } else if (!dropping) { if (line.length >= 8192) { line = ""; dropping = true; } else line += character; } } });
    child.stderr?.resume();
    try {
      const written = options.onResource?.(resource) as unknown; if (written !== null && typeof written === "object" && "then" in written) { void Promise.resolve(written).catch(() => {}); throw new Error(); }
      if (scope.signal.aborted) abort(); await ready; scope.check(); clearTimeout(timer);
    } catch (error) { await close(); throw error; }
    const closed = cleanup.then(() => ({ reason: stopped ? "stopped" as const : "exited" as const }));
    void closed.catch(() => {});
    const mapping = Object.freeze({ protocol: "udp" as const, publicHost: config.publicHost, publicPort: config.publicPort, localAddress: options.localTarget.address, localPort: options.localTarget.port, ownerId: options.localTarget.ownerId, requestId: options.requestId, expiresAt });
    return Object.freeze({ kind: `${config.provider}.udp` as "netbird.udp" | "pangolin.udp", mapping, resource, closed, close });
  } catch (error) {
    if (!spawned) { scope.dispose(); await bridge.close(); await rm(directory, { recursive: true, force: true }); }
    if (error instanceof LinkspanError) throw error;
    throw new LinkspanError("outcome_unknown", "The UDP mapping lifetime could not be confirmed.", { outcome: "unknown" });
  }
}

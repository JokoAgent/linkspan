import { spawn, type ChildProcess } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { CloudflareConnectorError, cloudflaredArtifact, verifyCloudflared } from "./artifacts.js";
export * from "./artifacts.js";
export * from "./named.js";

export const QUICK_TUNNEL_LIMITS = Object.freeze({
  temporaryHostname: true,
  maximumInflightRequests: 200,
  serverSentEvents: false,
  serviceLevelAgreement: false,
  intendedUse: "testing-and-development" as const
});

export interface QuickTunnelOptions {
  /** Stable host operation identity, reserved before the external effect. */
  readonly requestId: string;
  /** The prepared, pinned helper. No runtime download or update is performed. */
  readonly executable: string;
  readonly target?: string;
  /** A dedicated loopback listener exposing only the encrypted application carrier. */
  readonly localOrigin: string;
  /** Host-approved PEM certificate bundle; only these public certificates reach the child. */
  readonly originCaPool: string;
  /** Fixed origin certificate identity. Never derived from the remote Host header. */
  readonly originServerName: string;
  readonly signal?: AbortSignal;
  /** Absolute Unix epoch milliseconds. This bounds startup and the active lease. */
  readonly deadline?: number;
  readonly startupTimeoutMs?: number;
  /** Synchronously persist the exact child identity in the already claimed host operation. */
  readonly onSpawn?: (resource: { readonly processId: number; readonly requestId: string }) => void;
}

export interface CloudflareTunnelExit {
  readonly reason: "stopped" | "exited";
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface QuickTunnel {
  readonly kind: "cloudflare.quick";
  readonly requestId: string;
  readonly processId: number;
  readonly publicOrigin: string;
  readonly limits: typeof QUICK_TUNNEL_LIMITS;
  readonly closed: Promise<CloudflareTunnelExit>;
  /** Idempotent, bounded shutdown of exactly this owned child process. */
  close(): Promise<void>;
}

export interface NamedTunnelOptions extends QuickTunnelOptions {
  readonly accountId: string;
  readonly tunnelId: string;
  /** Locally managed tunnel secret; not a Cloudflare API token or host key. */
  readonly tunnelSecret: string;
  readonly publicOrigin: string;
}
export interface NamedTunnel extends Omit<QuickTunnel, "kind" | "limits"> {
  readonly kind: "cloudflare.named";
  readonly limits: Readonly<{ temporaryHostname: false; serviceLevelAgreement: false; notes: readonly string[] }>;
}
const NAMED_TUNNEL_LIMITS = Object.freeze({ temporaryHostname: false as const, serviceLevelAgreement: false as const,
  notes: Object.freeze(["Existing publisher account and domain required; CDN plan, request, upload and connection limits apply.", "Outer TLS terminates at Cloudflare; only the fixed encrypted application carrier is exposed."]) });

export async function startNamedTunnel(options: NamedTunnelOptions): Promise<NamedTunnel> {
  if (!/^[a-f0-9]{32}$/u.test(options.accountId) || !/^[a-f0-9-]{36}$/u.test(options.tunnelId)
    || !/^[A-Za-z0-9+/]{43}=$/u.test(options.tunnelSecret)) throw new CloudflareConnectorError("invalid_input", "A locally managed tunnel identity and 32-byte secret are required.");
  let origin: URL;
  try { origin = new URL(options.publicOrigin); } catch { throw invalidOrigin(); }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.port || origin.pathname !== "/" || origin.search || origin.hash) throw new CloudflareConnectorError("invalid_input", "The named tunnel requires a public HTTPS hostname.");
  const result = await startCloudflareTunnel(options, options);
  return Object.freeze({ ...result, kind: "cloudflare.named", limits: NAMED_TUNNEL_LIMITS });
}

/** Validates without probing the target or starting a backend. */
export function validateCloudflareLocalOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidOrigin(); }
  if (url.protocol !== "https:" || !["127.0.0.1", "[::1]"].includes(url.hostname)
    || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || url.origin !== value.replace(/\/$/, "")) throw invalidOrigin();
  return url.origin;
}

function invalidOrigin(): CloudflareConnectorError {
  return new CloudflareConnectorError("invalid_input", "The connector target must be an explicit HTTPS loopback origin for the encrypted carrier.");
}

function validateOriginServerName(value: string): void {
  const domain = typeof value === "string" && value.length <= 253
    && value.split(".").every(label => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label));
  if (typeof value !== "string" || (isIP(value) === 0 && !domain)) {
    throw new CloudflareConnectorError("invalid_input", "A fixed origin certificate server name is required.");
  }
}

async function readOriginCaPool(path: string): Promise<string> {
  if (typeof path !== "string" || !isAbsolute(path)) throw new CloudflareConnectorError("invalid_input", "An absolute origin certificate bundle path is required.");
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 64 * 1024) throw new Error();
    const content = await readFile(path, "utf8");
    const certificates = content.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu);
    if (certificates === null || certificates.length > 16 || content.length > 64 * 1024
      || content.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/gu, "").trim() !== "") throw new Error();
    for (const certificate of certificates) new X509Certificate(certificate);
    return `${certificates.join("\n")}\n`;
  } catch {
    throw new CloudflareConnectorError("invalid_input", "The origin trust bundle must contain bounded public PEM certificates only.");
  }
}

function abortFailure(signal?: AbortSignal, deadline?: number): CloudflareConnectorError | undefined {
  if (deadline !== undefined && Date.now() >= deadline) return new CloudflareConnectorError("deadline", "The connector deadline was reached.");
  if (signal?.aborted) return new CloudflareConnectorError("cancelled", "The connector operation was cancelled.");
  return undefined;
}

/**
 * Starts one account-free Quick Tunnel. The child receives no inherited host
 * credentials, no endpoint key and no caller-supplied arguments or configuration.
 * The host owns business authorization and must expose only its encrypted carrier.
 */
export async function startQuickTunnel(options: QuickTunnelOptions): Promise<QuickTunnel> {
  return startCloudflareTunnel(options);
}

async function startCloudflareTunnel(options: QuickTunnelOptions, named?: NamedTunnelOptions): Promise<QuickTunnel> {
  const localOrigin = validateCloudflareLocalOrigin(options.localOrigin);
  validateOriginServerName(options.originServerName);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(options.requestId)) throw new CloudflareConnectorError("invalid_input", "A bounded stable connector request identity is required.");
  const timeoutMs = options.startupTimeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 180_000
    || (options.deadline !== undefined && (!Number.isSafeInteger(options.deadline) || options.deadline <= 0))) {
    throw new CloudflareConnectorError("invalid_input", "Connector startup and deadline bounds are invalid.");
  }
  const artifact = cloudflaredArtifact(options.target);
  if (artifact.target !== `${process.platform}-${process.arch}`) throw new CloudflareConnectorError("unsupported_platform", "A helper for another target cannot run on this host.");
  const preflightFailure = abortFailure(options.signal, options.deadline);
  if (preflightFailure) throw preflightFailure;
  const originCaPool = await readOriginCaPool(options.originCaPool);
  await verifyCloudflared({ executable: options.executable, target: artifact.target, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  const verifiedFailure = abortFailure(options.signal, options.deadline);
  if (verifiedFailure) throw verifiedFailure;

  const directory = await mkdtemp(join(tmpdir(), "linkspan-cloudflare-"));
  const config = join(directory, "config.yml");
  const certificateBundle = join(directory, "origin-certificates.pem");
  const environment: NodeJS.ProcessEnv = {
    HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory,
    TMPDIR: directory, TMP: directory, TEMP: directory,
    NO_AUTOUPDATE: "true"
  };
  // Go/Windows needs the operating system directory. Business, provider, proxy,
  // debug and TUNNEL_* variables are intentionally not inherited.
  for (const name of ["SystemRoot", "WINDIR"] as const) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  let child: ChildProcess;
  try {
    await chmod(directory, 0o700);
    if (named) {
      const credentials = join(directory, "credentials.json");
      await writeFile(credentials, JSON.stringify({ AccountTag: named.accountId, TunnelID: named.tunnelId, TunnelSecret: named.tunnelSecret }), { flag: "wx", mode: 0o600 });
      await writeFile(config, JSON.stringify({ tunnel: named.tunnelId, "credentials-file": credentials,
        ingress: [{ hostname: new URL(named.publicOrigin).hostname, service: localOrigin,
          originRequest: { caPool: certificateBundle, originServerName: options.originServerName } }, { service: "http_status:404" }] }), { flag: "wx", mode: 0o600 });
    } else await writeFile(config, "# Managed single-origin Linkspan carrier.\n{}\n", { flag: "wx", mode: 0o600 });
    await writeFile(certificateBundle, originCaPool, { flag: "wx", mode: 0o600 });
    child = spawn(options.executable, ["tunnel", "--config", config, "--no-autoupdate", "--protocol", "http2", "--metrics", "127.0.0.1:0", "--management-diagnostics=false", "--loglevel", "info", ...(named ? ["run", named.tunnelId] : ["--origin-ca-pool", certificateBundle, "--origin-server-name", options.originServerName, "--url", localOrigin])], {
      cwd: directory, env: environment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false
    });
  } catch {
    await rm(directory, { recursive: true, force: true }).catch(() => { throw new CloudflareConnectorError("cleanup_failed", "The connector preparation directory could not be retired."); });
    throw new CloudflareConnectorError("unavailable", "The managed connector process could not start.");
  }

  let stopping = false;
  let exitSeen = false;
  let url: string | undefined = named?.publicOrigin.replace(/\/$/u, "");
  let registered = false;
  let readySettled = false;
  let resolveReady!: (origin: string) => void;
  let rejectReady!: (error: CloudflareConnectorError) => void;
  const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let resolveExit!: (exit: CloudflareTunnelExit) => void;
  const processExit = new Promise<CloudflareTunnelExit>(resolve => { resolveExit = resolve; });
  const failReady = (error: CloudflareConnectorError): void => { if (!readySettled) { readySettled = true; rejectReady(error); } };
  const maybeReady = (): void => { if (!readySettled && url !== undefined && registered) { readySettled = true; resolveReady(url); } };

  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      stopping = true;
      failReady(new CloudflareConnectorError("closed", "The connector was stopped before it became ready."));
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let limitTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!exitSeen) child.kill("SIGTERM");
        killTimer = setTimeout(() => { if (!exitSeen) child.kill("SIGKILL"); }, 5_000);
        const limit = new Promise<never>((_resolve, reject) => {
          limitTimer = setTimeout(() => reject(new CloudflareConnectorError("cleanup_failed", "The owned connector process did not confirm shutdown.")), 10_000);
        });
        await Promise.race([processExit, limit]);
        await cleanup;
      } catch {
        throw new CloudflareConnectorError("cleanup_failed", "The owned connector cleanup could not be confirmed.");
      } finally { if (killTimer) clearTimeout(killTimer); if (limitTimer) clearTimeout(limitTimer); }
    })();
    return stopPromise;
  };

  child.once("error", () => {
    failReady(new CloudflareConnectorError("unavailable", "The managed connector process failed."));
  });
  child.once("close", (exitCode, signal) => {
    exitSeen = true;
    failReady(new CloudflareConnectorError("unavailable", "The managed connector exited before it became ready."));
    resolveExit({ reason: stopping ? "stopped" : "exited", exitCode, signal });
  });

  // These callbacks retain the child object, never a persisted PID. They do not
  // replace the host's signal handlers or suppress an uncaught exception.
  const onParentExit = (): void => { if (!exitSeen) child.kill("SIGTERM"); };
  process.once("exit", onParentExit);
  process.once("uncaughtExceptionMonitor", onParentExit);

  const observeLine = (line: string): void => {
    const match = /https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com\b/u.exec(line);
    if (match && url === undefined) url = match[0];
    if (line.includes("Registered tunnel connection")) registered = true;
    maybeReady();
  };
  // Log content is never returned or forwarded. Bounded lines only discover the
  // public hostname and successful carrier registration, never business state.
  const observeStream = (stream: NodeJS.ReadableStream | null): void => {
    let buffer = "";
    let dropping = false;
    stream?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const character of text) {
        if (character === "\n") { if (!dropping) observeLine(buffer); buffer = ""; dropping = false; }
        else if (!dropping) { if (buffer.length >= 8192) { buffer = ""; dropping = true; } else buffer += character; }
      }
    });
  };
  observeStream(child.stdout); observeStream(child.stderr);

  const onAbort = (): void => {
    failReady(abortFailure(options.signal, options.deadline) ?? new CloudflareConnectorError("cancelled", "The connector operation was cancelled."));
    void stop().catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  if (options.deadline !== undefined) {
    const deadline = options.deadline;
    const armDeadline = (): void => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) onAbort();
      else deadlineTimer = setTimeout(armDeadline, Math.min(2_147_483_647, remaining));
    };
    armDeadline();
  }
  const startupTimer = setTimeout(() => {
    failReady(new CloudflareConnectorError("deadline", "The managed connector did not become ready within its startup bound."));
    void stop().catch(() => undefined);
  }, timeoutMs);
  const cleanup = processExit.then(async exit => {
    clearTimeout(startupTimer); if (deadlineTimer) clearTimeout(deadlineTimer);
    options.signal?.removeEventListener("abort", onAbort);
    process.removeListener("exit", onParentExit);
    process.removeListener("uncaughtExceptionMonitor", onParentExit);
    await rm(directory, { recursive: true, force: true }).catch(() => { throw new CloudflareConnectorError("cleanup_failed", "The owned connector directory could not be retired."); });
    return exit;
  });
  // A late filesystem cleanup failure is observable through close()/closed, but
  // must not become an unhandled rejection when a host is already shutting down.
  void cleanup.catch(() => undefined);
  if (child.pid !== undefined) {
    try {
      const returned: unknown = options.onSpawn?.({ processId: child.pid, requestId: options.requestId });
      if (returned !== null && typeof returned === "object" && "then" in returned) {
        void Promise.resolve(returned).catch(() => undefined);
        throw new Error("The resource callback must complete synchronously.");
      }
    } catch {
      failReady(new CloudflareConnectorError("unavailable", "The host could not record the owned connector process."));
      void stop().catch(() => undefined);
    }
  }
  if (abortFailure(options.signal, options.deadline)) onAbort();
  try {
    const publicOrigin = await ready;
    clearTimeout(startupTimer);
    if (child.pid === undefined) throw new CloudflareConnectorError("unavailable", "The managed connector process identity is unavailable.");
    return Object.freeze({ kind: "cloudflare.quick", requestId: options.requestId, processId: child.pid, publicOrigin, limits: QUICK_TUNNEL_LIMITS, closed: cleanup, close: stop });
  } catch (error) {
    await stop();
    throw error;
  }
}

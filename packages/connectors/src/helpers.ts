import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, lstat, readFile, chmod, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createOperationScope, LinkspanError } from "@jokoagent/linkspan-core";
import { verifyConnectorHelper } from "./artifacts.js";
import { boundedText, invalid, publicOrigin, readCertificateBundle, startWithLifecycle, type OriginBridge, type StartedCarrier } from "./runtime.js";
import type { Connector, ConnectorConfig, ConnectorHelper, ConnectorOptions, ConnectorResource } from "./types.js";

const port = (value: number): number => {
  if (!Number.isInteger(value) || value < 1 || value > 65535) invalid("The selected carrier port is invalid.");
  return value;
};
const address = (value: string): string => {
  boundedText(value, "relay network address", 512);
  if (/[\s/@?#\\]/u.test(value)) invalid("The relay network address is invalid.");
  return value;
};
const toml = (value: string): string => JSON.stringify(value);

interface Invocation {
  readonly args: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly expectedOrigin?: string;
  readonly resourceOwner?: string;
  ready(line: string): string | undefined;
}

async function invocation(config: ConnectorConfig, options: ConnectorOptions, bridge: OriginBridge, directory: string): Promise<Invocation> {
  const file = join(directory, `connector.${config.provider === "frp" || config.provider === "rathole" ? "toml" : "json"}`);
  const save = (value: string) => writeFile(file, value, { flag: "wx", mode: 0o600 });
  switch (config.provider) {
    case "frp": {
      address(config.serverAddress); port(config.serverPort); boundedText(config.token, "relay publisher token"); address(config.serverName);
      if (!["tcp", "http", "https"].includes(config.mode)) invalid("Only public frp TCP, HTTP and HTTPS proxies are supported.");
      const origin = publicOrigin(config.publicOrigin);
      const ca = await readCertificateBundle(config.serverCaPool); const caFile = join(directory, "relay-ca.pem");
      await writeFile(caFile, ca, { flag: "wx", mode: 0o600 });
      if (config.mode === "tcp" && config.remotePort === undefined) invalid("A stable public frp TCP port is required.");
      await save(`serverAddr = ${toml(config.serverAddress)}\nserverPort = ${config.serverPort}\nauth.method = "token"\nauth.token = ${toml(config.token)}\ntransport.tls.enable = true\ntransport.tls.serverName = ${toml(config.serverName)}\ntransport.tls.trustedCaFile = ${toml(caFile)}\nwebServer.addr = "127.0.0.1"\nwebServer.port = 0\nlog.to = "console"\nlog.level = "info"\nloginFailExit = true\n[[proxies]]\nname = ${toml(`linkspan-${options.requestId}`)}\ntype = ${toml(config.mode)}\nlocalIP = "127.0.0.1"\nlocalPort = ${bridge.port}\n${config.mode === "tcp" ? `remotePort = ${port(config.remotePort!)}\n` : `customDomains = [${toml(new URL(origin).hostname)}]\n`}`);
      return { args: ["-c", file], expectedOrigin: origin, ready: line => line.includes("start proxy success") ? origin : undefined };
    }
    case "rathole": {
      address(config.remoteAddress); boundedText(config.token, "relay service token");
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(config.serviceName)) invalid("The rathole service identity is invalid.");
      let transport: string;
      if (config.transport.type === "noise") {
        if (!/^[A-Za-z0-9+/]{43}=$/u.test(config.transport.remotePublicKey)) invalid("A fixed relay Noise public key is required.");
        transport = `[client.transport]\ntype = "noise"\n[client.transport.noise]\nremote_public_key = ${toml(config.transport.remotePublicKey)}\n`;
      } else if (config.transport.type === "tls") {
        const caFile = join(directory, "relay-ca.pem"); await writeFile(caFile, await readCertificateBundle(config.transport.trustedRoot), { flag: "wx", mode: 0o600 });
        address(config.transport.hostname);
        transport = `[client.transport]\ntype = "tls"\n[client.transport.tls]\nhostname = ${toml(config.transport.hostname)}\ntrusted_root = ${toml(caFile)}\n`;
      } else return invalid("The connector-to-relay transport must be Noise or verified TLS.");
      const origin = publicOrigin(config.publicOrigin);
      await save(`[client]\nremote_addr = ${toml(config.remoteAddress)}\n${transport}\n[client.services.${config.serviceName}]\ntoken = ${toml(config.token)}\nlocal_addr = ${toml(bridge.address)}\n`);
      return { args: ["--client", file], expectedOrigin: origin, ready: line => line.includes("Control channel established") ? origin : undefined };
    }
    case "bore": {
      address(config.serverAddress); port(config.remotePort);
      const origin = publicOrigin(config.publicOrigin);
      if (Number(new URL(origin).port || 443) !== config.remotePort) invalid("The public bore origin must use the exact fixed remote port.");
      if (config.secret !== undefined) boundedText(config.secret, "relay publisher secret");
      return { args: ["local", String(bridge.port), "--local-host", bridge.host, "--to", config.serverAddress, "--port", String(config.remotePort)],
        environment: config.secret === undefined ? {} : { BORE_SECRET: config.secret }, expectedOrigin: origin, ready: line => line.includes(`listening at ${config.serverAddress}:${config.remotePort}`) ? origin : undefined };
    }
    case "funnel": {
      if (!config.hostname.endsWith(".ts.net") || ![443, 8443, 10000].includes(config.port) || !isAbsolute(config.stateDirectory)) invalid("Funnel requires a ts.net hostname, approved port and private absolute state directory.");
      if (config.mode !== undefined && !["http", "tcp"].includes(config.mode)) invalid("The Funnel byte carrier mode is invalid.");
      address(config.hostname); boundedText(config.authKey, "tailnet publisher setup key");
      const origin = `https://${config.hostname}${config.port === 443 ? "" : `:${config.port}`}`;
      await save(JSON.stringify({ requestId: options.requestId, mode: config.mode ?? "http", localAddress: bridge.address, hostname: config.hostname, authKey: config.authKey, stateDirectory: config.stateDirectory, port: config.port }));
      return embeddedInvocation(file, origin);
    }
    case "netbird": {
      publicOrigin(config.managementUrl); publicOrigin(config.publicOrigin); port(config.listenPort);
      if (!isAbsolute(config.stateDirectory) || !["http", "tcp", "tls"].includes(config.mode)) invalid("The dedicated proxy peer needs an absolute private state directory and public mode.");
      boundedText(config.setupKey, "dedicated peer setup key"); boundedText(config.resourceId, "public resource identity", 128);
      await save(JSON.stringify({ requestId: options.requestId, mode: config.mode, localAddress: bridge.address, managementUrl: config.managementUrl, setupKey: config.setupKey, stateDirectory: config.stateDirectory, listenPort: config.listenPort, publicOrigin: config.publicOrigin }));
      return embeddedInvocation(file, config.publicOrigin);
    }
    case "pangolin": {
      publicOrigin(config.endpoint); const origin = publicOrigin(config.publicOrigin);
      if (!["http", "tcp"].includes(config.mode)) invalid("The public Pangolin byte carrier must select HTTP or TLS-over-TCP forwarding.");
      boundedText(config.siteId, "dedicated site identity", 128); boundedText(config.siteSecret, "site publisher secret");
      await save(JSON.stringify({ requestId: options.requestId, mode: config.mode, localAddress: bridge.address, endpoint: config.endpoint, siteId: config.siteId, siteSecret: config.siteSecret, publicOrigin: origin }));
      return embeddedInvocation(file, origin);
    }
    case "zrok": {
      if (!isAbsolute(config.environmentDirectory) || !["public", "reserved"].includes(config.mode)) invalid("A separately enabled private zrok environment directory is required.");
      if (config.mode === "reserved" && (!config.reservedToken || !/^[A-Za-z0-9_-]{1,128}:[A-Za-z0-9_-]{1,128}$/u.test(config.reservedToken))) invalid("The reserved frontend namespace:name selection is required.");
      if (config.helper.version !== "zrok-source-2.0.8") invalid("The public zrok carrier requires the fixed Linkspan SDK helper.");
      const resourceOwner = await snapshotZrokEnvironment(config.environmentDirectory, directory);
      const origin = config.publicOrigin === undefined ? undefined : publicOrigin(config.publicOrigin);
      await save(JSON.stringify({ action: "serve", requestId: options.requestId, localAddress: bridge.address, mode: config.mode, nameSelection: config.reservedToken ?? "" }));
      return { args: ["--config", file], resourceOwner,
        ...(origin === undefined ? {} : { expectedOrigin: origin }),
        ready(line) {
          try { const value = JSON.parse(line) as { type?: string; publicOrigin?: string }; return value.type === "ready" && typeof value.publicOrigin === "string" ? publicOrigin(value.publicOrigin) : undefined; } catch { return; }
        } };
    }
    default: return invalid("The selected carrier does not use a managed helper.");
  }
}

async function snapshotZrokEnvironment(source: string, home: string): Promise<string> {
  const info = await lstat(source).catch(() => { throw new LinkspanError("invalid_argument", "The private zrok environment is unavailable."); });
  if (!info.isDirectory() || info.isSymbolicLink()) invalid("The private zrok environment must be a real directory.");
  const destination = join(home, ".zrok2"); await mkdir(destination, { mode: 0o700 });
  const copy = async (name: string, maximum: number): Promise<Buffer> => {
    const path = join(source, name); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > maximum) invalid("The selected zrok environment contains an invalid credential file.");
    const bytes = await readFile(path);
    await writeFile(join(destination, name), bytes, { flag: "wx", mode: 0o600 }); return bytes;
  };
  try {
    const metadata = JSON.parse((await copy("metadata.json", 4096)).toString("utf8")) as { v?: string };
    if (metadata.v !== "v0.4") invalid("The selected zrok environment metadata does not match the fixed SDK version.");
    const environment = JSON.parse((await copy("environment.json", 65_536)).toString("utf8")) as { ziti_identity?: string; zrok_token?: string };
    if (!environment.ziti_identity || !/^[A-Za-z0-9_-]{1,128}$/u.test(environment.ziti_identity)) invalid("The selected zrok publisher identity is invalid.");
    const identities = await lstat(join(source, "identities"));
    if (!identities.isDirectory() || identities.isSymbolicLink()) invalid("The selected zrok identity directory is invalid.");
    await mkdir(join(destination, "identities"), { mode: 0o700 });
    await copy(`identities/${environment.ziti_identity}.json`, 256 * 1024);
    const configExists = await lstat(join(source, "config.json")).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
    if (configExists) await copy("config.json", 65_536);
    if (typeof environment.zrok_token !== "string" || environment.zrok_token.length < 1 || environment.zrok_token.length > 8192) invalid("The selected zrok publisher context is invalid.");
    return `${createHash("sha256").update(environment.zrok_token).digest("hex")}:${environment.ziti_identity}`;
  } catch (error) { if (error instanceof LinkspanError) throw error; throw new LinkspanError("invalid_argument", "The fixed zrok SDK environment could not be read safely."); }
}
function embeddedInvocation(file: string, expectedOrigin: string): Invocation {
  return { args: ["--config", file], expectedOrigin, ready(line) { try { const result = JSON.parse(line) as { type?: string; publicOrigin?: string }; return result.type === "ready" && result.publicOrigin === expectedOrigin ? expectedOrigin : undefined; } catch { return; } } };
}

async function spawnCarrier(config: ConnectorConfig & { readonly helper: ConnectorHelper }, options: ConnectorOptions, bridge: OriginBridge): Promise<StartedCarrier> {
  options.signal?.throwIfAborted();
  const helper = await verifyConnectorHelper(config.provider, config.helper);
  options.signal?.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), "linkspan-carrier-")); await chmod(directory, 0o700);
  let child: ChildProcess | undefined;
  let cleanup: Promise<void> | undefined;
  try {
    const input = await invocation(config, options, bridge, directory);
    options.signal?.throwIfAborted();
    const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory, TEMP: directory, TMP: directory, TMPDIR: directory, RUST_LOG: "info", NO_COLOR: "1", ...input.environment };
    for (const key of ["SystemRoot", "WINDIR"] as const) { const value = process.env[key]; if (value !== undefined) env[key] = value; }
    const graceful = ["funnel", "netbird", "pangolin", "zrok"].includes(config.provider);
    child = spawn(helper.executable, [...input.args], { cwd: directory, env, shell: false, windowsHide: true, stdio: [graceful ? "pipe" : "ignore", "pipe", "pipe"] });
    const owned = child;
    let exited = false;
    let resolveExit!: () => void;
    const processExit = new Promise<void>(resolve => { resolveExit = resolve; });
    let resolveReady!: (origin: string) => void; let rejectReady!: (error: Error) => void;
    const ready = new Promise<string>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    owned.once("error", () => rejectReady(new LinkspanError("unavailable", "The prepared carrier helper could not start.")));
    owned.once("close", () => { exited = true; resolveExit(); rejectReady(new LinkspanError("unavailable", "The carrier helper exited before registration.")); });
    let resource: ConnectorResource = Object.freeze({ provider: config.provider, requestId: options.requestId, id: `helper:${options.requestId}`, ...(owned.pid === undefined ? {} : { processId: owned.pid }), executableSha256: helper.sha256, createdByHost: true,
      ...(input.resourceOwner === undefined ? {} : { providerResourceOwner: input.resourceOwner }) });
    let retired = false;
    let stopPromise: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopPromise ??= (async () => {
        if (!exited) { if (graceful) owned.stdin?.end(); else owned.kill("SIGTERM"); }
        const kill = setTimeout(() => { if (!exited) owned.kill("SIGKILL"); }, graceful ? 8000 : 3000);
        try { await processExit; await cleanup; } finally { clearTimeout(kill); }
      })();
      return stopPromise;
    };
    const onParentExit = (): void => { if (!exited) owned.kill("SIGTERM"); };
    process.once("exit", onParentExit); process.once("uncaughtExceptionMonitor", onParentExit);
    const onAbort = (): void => { rejectReady(new LinkspanError("cancelled", "The carrier operation was cancelled.")); void stop().catch(() => {}); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { rejectReady(new LinkspanError("deadline_exceeded", "The carrier did not register within its startup bound.")); void stop().catch(() => {}); }, options.startupTimeoutMs ?? 60_000);
    cleanup = processExit.then(async () => {
      clearTimeout(timer); options.signal?.removeEventListener("abort", onAbort);
      process.removeListener("exit", onParentExit); process.removeListener("uncaughtExceptionMonitor", onParentExit);
      await rm(directory, { recursive: true, force: true });
      if (config.provider === "zrok" && !retired) throw new LinkspanError("outcome_unknown", "The owned zrok share cleanup was not confirmed; reconcile its original public resource handle.", { outcome: "unknown" });
    });
    void cleanup.catch(() => {});
    const observe = (stream: NodeJS.ReadableStream | null): void => {
      let line = ""; let dropping = false;
      stream?.on("data", (data: Buffer) => { for (const character of data.toString("utf8")) {
        if (character === "\n") {
          if (!dropping) {
            if (config.provider === "zrok" && line.trimStart().startsWith("{")) try {
              const value = JSON.parse(line) as { type?: string; resourceId?: string; resourceOwner?: string; code?: string };
              if (value.type === "resource" && typeof value.resourceId === "string" && /^[A-Za-z0-9_-]{3,128}$/u.test(value.resourceId) && value.resourceOwner === input.resourceOwner) {
                resource = Object.freeze({ ...resource, providerResourceId: value.resourceId });
                const written = options.onResource?.(resource) as unknown;
                if (written !== null && typeof written === "object" && "then" in written) { void Promise.resolve(written).catch(() => {}); throw new Error(); }
              }
              if (value.type === "error" && resource.providerResourceId === undefined && ["invalid_config", "authentication_failed"].includes(value.code ?? "")) { retired = true; rejectReady(new LinkspanError(value.code === "authentication_failed" ? "authentication_failed" : "invalid_argument", "The selected zrok publisher configuration was rejected before resource creation.", { outcome: "not_sent" })); }
              if (value.type === "retired" && value.resourceId === resource.providerResourceId) retired = true;
              if (value.type === "error" && value.code === "outcome_unknown") { rejectReady(new LinkspanError("outcome_unknown", "The zrok provider effect could not be confirmed.", { outcome: "unknown" })); }
            } catch { rejectReady(new LinkspanError("outcome_unknown", "The host could not record the exact provider resource.", { outcome: "unknown" })); void stop().catch(() => {}); }
            const origin = input.ready(line); if (origin !== undefined) { if (input.expectedOrigin !== undefined && publicOrigin(origin) !== input.expectedOrigin) rejectReady(new LinkspanError("identity_mismatch", "The carrier returned a different public address.")); else resolveReady(publicOrigin(origin)); }
          }
          line = ""; dropping = false;
        } else if (!dropping) { if (line.length >= 8192) { line = ""; dropping = true; } else line += character; }
      } });
    };
    observe(owned.stdout); observe(owned.stderr);
    try {
      const receipt = options.onResource?.(resource) as unknown;
      if (receipt !== null && typeof receipt === "object" && "then" in receipt) { void Promise.resolve(receipt).catch(() => {}); throw new LinkspanError("unavailable", "The host resource journal must complete synchronously."); }
    } catch (error) { await stop(); throw error; }
    if (options.signal?.aborted) onAbort();
    try { const origin = await ready; clearTimeout(timer); return { publicOrigin: origin, resource, closed: cleanup, close: stop }; }
    catch (error) { await stop(); throw error; }
  } catch (error) {
    if (child === undefined) await rm(directory, { recursive: true, force: true });
    else if (cleanup === undefined) { child.kill("SIGTERM"); await rm(directory, { recursive: true, force: true }); }
    throw error;
  }
}

export async function startHelperConnector(config: ConnectorConfig, options: ConnectorOptions): Promise<Connector> {
  if (!("helper" in config)) invalid("This carrier requires an explicitly prepared helper.");
  const http = (config.provider === "funnel" && config.mode !== "tcp") || config.provider === "zrok" || (config.provider === "frp" && config.mode === "http") || (config.provider === "pangolin" && config.mode === "http") || (config.provider === "netbird" && config.mode === "http");
  return startWithLifecycle(config, options, http ? "http" : "tls", (bridge, signal) => spawnCarrier(config, { ...options, signal }, bridge));
}

/** Recovery never adopts a name or kills a PID. Only an exact share receipt
 * created by this operation and its original environment may be retired. */
export async function reconcileZrokResource(config: Extract<ConnectorConfig, { provider: "zrok" }>, resource: ConnectorResource, options: { readonly requestId: string; readonly signal?: AbortSignal; readonly deadline?: number }): Promise<{ readonly state: "retired" | "outcome_unknown" }> {
  if (resource.provider !== "zrok" || resource.requestId !== options.requestId || resource.id !== `helper:${options.requestId}` || resource.createdByHost !== true) invalid("The saved zrok share does not belong to this operation.");
  if (!resource.providerResourceId || !resource.providerResourceOwner) return { state: "outcome_unknown" };
  if (!/^[A-Za-z0-9_-]{3,128}$/u.test(resource.providerResourceId) || !/^[a-f0-9]{64}:[A-Za-z0-9_-]{1,128}$/u.test(resource.providerResourceOwner)) invalid("The original zrok share receipt is invalid.");
  if (resource.processId === undefined || !Number.isSafeInteger(resource.processId) || resource.processId < 1 || resource.processId === process.pid) return { state: "outcome_unknown" };
  try { process.kill(resource.processId, 0); return { state: "outcome_unknown" }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return { state: "outcome_unknown" }; }
  if (config.helper.version !== "zrok-source-2.0.8" || resource.executableSha256 !== config.helper.sha256) return { state: "outcome_unknown" };
  const scope = createOperationScope({ ...(options.signal === undefined ? {} : { signal: options.signal }), deadline: Math.min(options.deadline ?? Infinity, Date.now() + 10_000) });
  let directory: string | undefined; let child: ChildProcess | undefined;
  try {
    scope.check(); const helper = await verifyConnectorHelper("zrok", config.helper); scope.check();
    directory = await mkdtemp(join(tmpdir(), "linkspan-zrok-recover-")); await chmod(directory, 0o700);
    const owner = await snapshotZrokEnvironment(config.environmentDirectory, directory);
    // Account credentials may be rotated, but the dedicated environment identity
    // must be unchanged. The Go SDK then checks exact server-side EnvZID/mode.
    if (owner.split(":")[1] !== resource.providerResourceOwner.split(":")[1]) invalid("The selected zrok environment does not own the original share.");
    const file = join(directory, "cleanup.json");
    await writeFile(file, JSON.stringify({ action: "cleanup", requestId: options.requestId, resourceId: resource.providerResourceId, resourceOwner: resource.providerResourceOwner }), { flag: "wx", mode: 0o600 }); scope.check();
    const environment: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory, TEMP: directory, TMP: directory, TMPDIR: directory, NO_COLOR: "1" };
    for (const key of ["SystemRoot", "WINDIR"] as const) if (process.env[key] !== undefined) environment[key] = process.env[key];
    child = spawn(helper.executable, ["--config", file], { cwd: directory, env: environment, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const owned = child; let retired = false; let line = ""; let dropping = false;
    const ended = new Promise<void>(resolve => { owned.once("close", () => resolve()); owned.once("error", () => resolve()); });
    owned.stdout?.on("data", (data: Buffer) => { for (const character of data.toString("utf8")) { if (character === "\n") {
      if (!dropping) try { const value = JSON.parse(line) as { type?: string; resourceId?: string }; if (value.type === "retired" && value.resourceId === resource.providerResourceId) retired = true; } catch {}
      line = ""; dropping = false;
    } else if (!dropping) { if (line.length >= 8192) { line = ""; dropping = true; } else line += character; } } });
    owned.stderr?.resume();
    try { await scope.wait(ended); }
    catch { owned.kill("SIGKILL"); await ended; return { state: "outcome_unknown" }; }
    return { state: retired ? "retired" : "outcome_unknown" };
  } finally {
    scope.dispose(); if (child && child.exitCode === null) child.kill("SIGKILL");
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

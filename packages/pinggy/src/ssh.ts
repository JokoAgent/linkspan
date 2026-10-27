import { createHash, timingSafeEqual } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { EventEmitter } from "node:events";
import { createOperationScope } from "@jokoagent/linkspan-core";
import type { Connector, ConnectorOptions, PinggyConfig } from "@jokoagent/linkspan-connector-runtime";
import { invalid, publicOrigin, startWithLifecycle } from "@jokoagent/linkspan-connector-runtime/runtime";
import { pinggyByteMode } from "./sdk.js";

interface Client extends EventEmitter {
  connect(config: object): void;
  forwardIn(address: string, port: number, callback: (error?: Error) => void): void;
  exec(command: string, callback: (error: Error | undefined, stream: Socket & { stderr: EventEmitter }) => void): void;
  end(): void;
  destroy(): void;
}

/** Explicit SSH runtime for hosts whose native ABI is not a published SDK
 * target (including Electron). No system SSH install or automatic fallback. */
export async function startSsh(config: PinggyConfig, options: ConnectorOptions): Promise<Connector> {
  const fingerprint = config.serverHostKeySha256;
  if (!fingerprint || !/^SHA256:[A-Za-z0-9+/]{43}=?$/u.test(fingerprint)) invalid("The explicit Pinggy SSH runtime requires an independently trusted SHA256 server host-key fingerprint.");
  if (config.token !== undefined && !/^[A-Za-z0-9_-]{1,512}$/u.test(config.token)) invalid("The publisher tunnel token is invalid.");
  const server = config.serverAddress ?? (config.token === undefined ? "free.pinggy.io" : "pro.pinggy.io");
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u.test(server)) invalid("The selected Pinggy SSH service hostname is invalid.");
  if (config.mode !== "http" && !config.publicOrigin) invalid("A certificate-matching public origin is required for TLS/TCP passthrough.");
  const mode = pinggyByteMode(config);
  const bounded = config.budget.paidEnabled ? config : { ...config, budget: { ...config.budget, maximumSessionMs: Math.min(config.budget.maximumSessionMs, 3_600_000) } };
  return startWithLifecycle(bounded, options, mode.bridge, async (bridge, signal) => {
    const name = "ssh2"; const sdk = await import(name) as { Client: new () => Client };
    signal.throwIfAborted();
    const client = new sdk.Client(); const streams = new Set<Socket>();
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
    const terminate = (): void => { for (const stream of streams) stream.destroy(); client.destroy(); };
    signal.addEventListener("abort", terminate, { once: true });
    client.once("close", () => { signal.removeEventListener("abort", terminate); resolveClosed(); });
    client.on("error", () => {});
    client.on("tcp connection", (_info: unknown, accept: () => Socket, reject: () => void) => {
      if (signal.aborted || streams.size >= 32) { reject(); return; }
      const remote = accept(); const local = connect(bridge.port, bridge.host); streams.add(remote); streams.add(local);
      remote.on("error", () => local.destroy()); local.on("error", () => remote.destroy());
      remote.once("close", () => { streams.delete(remote); local.destroy(); }); local.once("close", () => { streams.delete(local); remote.destroy(); });
      remote.pipe(local); local.pipe(remote);
    });
    const startup = createOperationScope({ signal });
    try {
      await startup.wait(new Promise<void>((resolve, reject) => {
        client.once("ready", resolve); client.once("error", () => reject(new Error("The pinned Pinggy SSH service could not be authenticated.")));
        client.connect({ host: server, port: 443, username: `${config.token === undefined ? "" : config.token + "+"}${config.mode}`, authHandler: ["none"],
          hostVerifier(key: Buffer) { const actual = Buffer.from(createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")); const expected = Buffer.from(fingerprint.replace(/^SHA256:/u, "").replace(/=+$/u, "")); return actual.length === expected.length && timingSafeEqual(actual, expected); },
          readyTimeout: options.startupTimeoutMs ?? 60_000, keepaliveInterval: 15_000, keepaliveCountMax: 3, agentForward: false });
      }));
      await startup.wait(new Promise<void>((resolve, reject) => client.forwardIn("", 0, error => error ? reject(new Error("The Pinggy listener was rejected.")) : resolve())));
      const origin = await startup.wait(new Promise<string>((resolve, reject) => {
        client.exec(config.mode === "http" ? "x:https" : "", (error, stream) => {
          if (error) { reject(new Error("The Pinggy carrier setup failed.")); return; }
          if (signal.aborted) { stream.destroy(); reject(signal.reason); return; }
          streams.add(stream); stream.once("close", () => streams.delete(stream));
          stream.on("error", () => reject(new Error("The Pinggy carrier setup failed."))); stream.once("close", () => reject(new Error("The carrier setup ended before registration.")));
          let buffer = "";
          const observe = (data: Buffer): void => {
            buffer = (buffer + data.toString("utf8")).slice(-8192);
            const urls = buffer.match(/(?:https|tls|tcp|tlstcp):\/\/[A-Za-z0-9.-]+(?::[0-9]+)?/gu) ?? [];
            for (const value of urls) {
              if (new URL(value).protocol !== mode.scheme) continue;
              const url = value.replace(/^(?:tls|tcp|tlstcp):/u, "https:");
              if (config.publicOrigin !== undefined ? publicOrigin(url) === publicOrigin(config.publicOrigin) : new URL(url).hostname.endsWith(".pinggy.link")) { resolve(publicOrigin(url)); return; }
            }
          };
          stream.on("data", observe); stream.stderr.on("data", observe);
        });
      }));
      return { publicOrigin: origin, resource: { provider: "pinggy", requestId: options.requestId, id: `pinggy-ssh:${createHash("sha256").update(options.requestId).digest("hex")}`, createdByHost: true }, closed,
        async close() { terminate(); await closed; } };
    } catch (error) { terminate(); throw error; }
    finally { startup.dispose(); }
  });
}

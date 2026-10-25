import { createHash, timingSafeEqual } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { EventEmitter } from "node:events";
import type { Connector, ConnectorConfig, ConnectorOptions, SshConfig } from "@jokoagent/linkspan-connector-runtime";
import { boundedText, invalid, publicOrigin, startWithLifecycle } from "@jokoagent/linkspan-connector-runtime/runtime";
interface Client extends EventEmitter {
  connect(options: object): void;
  forwardIn(address: string, port: number, callback: (error: Error | undefined, port: number) => void): void;
  unforwardIn(address: string, port: number, callback: () => void): void;
  end(): void;
  destroy(): void;
}

export async function start(input: ConnectorConfig, options: ConnectorOptions): Promise<Connector> {
  if (input.provider !== "ssh") invalid("The SSH adapter requires SSH configuration.");
  const config = input as SshConfig;
  for (const [name, value] of Object.entries({ host: config.host, username: config.username, remoteBindAddress: config.remoteBindAddress })) boundedText(value, name, 253);
  if (!Number.isInteger(config.remotePort) || config.remotePort < 1 || config.remotePort > 65535 || !Number.isInteger(config.port ?? 22) || (config.port ?? 22) < 1 || (config.port ?? 22) > 65535) invalid("The SSH ports are invalid.");
  if (!/^SHA256:[A-Za-z0-9+/]{43}=?$/u.test(config.hostKeySha256)) invalid("A trusted SSH SHA256 host-key fingerprint is required.");
  if (!config.privateKey && !config.password) invalid("A publisher SSH key or password is required.");
  publicOrigin(config.publicOrigin);
  return startWithLifecycle(config, options, "tls", async bridge => {
    const packageName = "ssh2";
    const sdk = await import(packageName) as { Client: new () => Client };
    const client = new sdk.Client();
    const streams = new Set<Socket>();
    let resolveClosed!: () => void;
    let rejectClosed!: (error: Error) => void;
    const closed = new Promise<void>((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject; });
    void closed.catch(() => {});
    client.once("close", resolveClosed);
    client.on("error", () => { rejectClosed(new Error("SSH carrier disconnected.")); });
    client.on("tcp connection", (info: { destIP: string; destPort: number }, accept: () => Socket, reject: () => void) => {
      if (info.destPort !== config.remotePort || streams.size >= 32) { reject(); return; }
      const remote = accept();
      const local = connect(bridge.port, bridge.host);
      streams.add(remote); streams.add(local);
      remote.on("error", () => local.destroy()); local.on("error", () => remote.destroy());
      remote.once("close", () => { streams.delete(remote); local.destroy(); });
      local.once("close", () => { streams.delete(local); remote.destroy(); });
      remote.pipe(local); local.pipe(remote);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("ready", resolve); client.once("error", () => reject(new Error("SSH connection failed.")));
        client.connect({ host: config.host, port: config.port ?? 22, username: config.username,
          ...(config.privateKey === undefined ? {} : { privateKey: config.privateKey }), ...(config.passphrase === undefined ? {} : { passphrase: config.passphrase }), ...(config.password === undefined ? {} : { password: config.password }),
          hostVerifier(key: Buffer) { const actual = Buffer.from(createHash("sha256").update(key).digest("base64").replace(/=+$/u, "")); const expected = Buffer.from(config.hostKeySha256.replace(/^SHA256:/u, "").replace(/=+$/u, "")); return expected.length === actual.length && timingSafeEqual(actual, expected); },
          readyTimeout: options.startupTimeoutMs ?? 60_000, keepaliveInterval: 15_000, keepaliveCountMax: 3, agentForward: false, tryKeyboard: false });
      });
      await new Promise<void>((resolve, reject) => client.forwardIn(config.remoteBindAddress, config.remotePort, (error, actual) => error || actual !== config.remotePort ? reject(new Error("The remote SSH bind did not confirm the exact selected port.")) : resolve()));
    } catch (error) { client.destroy(); throw error; }
    return { publicOrigin: config.publicOrigin, resource: { provider: "ssh", requestId: options.requestId, id: `${config.host}:${config.remotePort}:${options.requestId}`, createdByHost: true }, closed,
      async close() { for (const stream of streams) stream.destroy(); await new Promise<void>(resolve => client.unforwardIn(config.remoteBindAddress, config.remotePort, resolve)); client.end(); await closed; } };
  });
}

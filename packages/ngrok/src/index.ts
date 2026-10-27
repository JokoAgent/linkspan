import type { Connector, ConnectorConfig, ConnectorOptions, NgrokConfig } from "@jokoagent/linkspan-connector-runtime";
import { boundedText, invalid, publicOrigin, startWithLifecycle } from "@jokoagent/linkspan-connector-runtime/runtime";

interface Listener { url(): string | null; id(): string; join(): Promise<void>; close(): Promise<void> }
interface Builder { domain(domain: string): Builder; scheme(scheme: string): Builder; remoteAddr(address: string): Builder; metadata(value: string): Builder; listenAndForward(address: string): Promise<Listener> }
interface Session { httpEndpoint(): Builder; tlsEndpoint(): Builder; tcpEndpoint(): Builder; close(): Promise<void> }
interface SessionBuilder { authtoken(value: string): SessionBuilder; clientInfo(name: string, version: string): SessionBuilder; connect(): Promise<Session> }

function ownedClose(resource: { close(): Promise<void> }): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    if (closing) return closing;
    const pending = Promise.resolve().then(() => resource.close());
    closing = pending;
    void pending.catch(() => { if (closing === pending) closing = undefined; });
    return pending;
  };
}

/** A private SDK session owns exactly this listener; no global disconnect/kill. */
export async function start(input: ConnectorConfig, options: ConnectorOptions): Promise<Connector> {
  if (input.provider !== "ngrok") invalid("The ngrok adapter requires ngrok configuration.");
  const config = input as NgrokConfig;
  boundedText(config.authtoken, "ngrok publisher token");
  if (!["http", "tls", "tcp"].includes(config.mode)) invalid("The ngrok carrier mode is unsupported.");
  if (config.domain !== undefined) boundedText(config.domain, "ngrok domain", 253);
  if (config.remoteAddress !== undefined) boundedText(config.remoteAddress, "ngrok reserved address", 512);
  if (config.mode !== "http" && config.publicOrigin === undefined) invalid("TLS/TCP carriers require the host's certificate-matching public HTTPS origin.");
  if (config.mode === "tls" && config.budget?.paidEnabled !== true) invalid("The ngrok TLS endpoint requires explicit consent to an existing paid plan.");
  if (config.publicOrigin !== undefined) publicOrigin(config.publicOrigin);
  return startWithLifecycle(config, options, config.mode === "http" ? "http" : "tls", async (bridge, signal) => {
    signal.throwIfAborted();
    const packageName = "@ngrok/ngrok";
    const sdk = await import(packageName) as { SessionBuilder: new () => SessionBuilder };
    signal.throwIfAborted();
    let closeSession: (() => Promise<void>) | undefined, closeListener: (() => Promise<void>) | undefined;
    // A session can be retired while listener setup is still pending. Each late
    // result gets its own cleanup handle, even if cancellation already won.
    const close = async () => {
      const results = await Promise.allSettled([closeListener?.(), closeSession?.()]);
      for (const result of results) if (result.status === "rejected") throw result.reason;
    };
    const cancel = () => { void close().catch(() => {}); };
    signal.addEventListener("abort", cancel, { once: true });
    try {
      signal.throwIfAborted();
      const session = await new sdk.SessionBuilder().authtoken(config.authtoken).clientInfo("linkspan", "0.1.0").connect();
      closeSession = ownedClose(session);
      signal.throwIfAborted();
      let builder = config.mode === "http" ? session.httpEndpoint() : config.mode === "tls" ? session.tlsEndpoint() : session.tcpEndpoint();
      if (config.mode === "http") builder = builder.scheme("https");
      if (config.domain !== undefined) builder = builder.domain(config.domain);
      if (config.remoteAddress !== undefined) {
        if (config.mode !== "tcp") invalid("Reserved TCP addresses apply only to the TCP carrier.");
        builder = builder.remoteAddr(config.remoteAddress);
      }
      const listener = await builder.metadata(`linkspan:${options.requestId}`).listenAndForward(bridge.origin);
      closeListener = ownedClose(listener);
      signal.throwIfAborted();
      const actual = listener.url();
      if (!actual) throw new Error();
      const mapped = actual.replace(/^(?:tcp|tls):/u, "https:");
      const address = config.publicOrigin ?? mapped;
      if (publicOrigin(mapped) !== publicOrigin(address)) throw new Error("The assigned endpoint differs from the selected public origin.");
      return { publicOrigin: address, resource: { provider: "ngrok", requestId: options.requestId, id: listener.id(), createdByHost: true }, closed: listener.join(),
        close };
    } catch (error) { await close(); throw error; }
    finally { signal.removeEventListener("abort", cancel); }
  });
}

import { connect as connectTcp, isIP, type Socket } from "node:net";
import { connect as connectTls, TLSSocket } from "node:tls";
import { asLinkspanError, createOperationScope, LinkspanError } from "@jokoagent/linkspan-core";
import type { StreamCarrier } from "@jokoagent/linkspan-core/stream";
import { HTTP_CONNECT_LIMITS, negotiateHttpConnect, normalizeHttpConnectAuthority,
  normalizeHttpConnectProxyOrigin, type HttpConnectOptions } from "./connect.js";
import { createNodeStreamCarrier } from "./node-stream.js";

export interface HttpConnectStreamOptions extends HttpConnectOptions {
  /** Explicit http(s) proxy origin. No environment proxy or visitor auth is used. */
  readonly proxyOrigin: string;
}

export async function connectHttpConnectStream(options: HttpConnectStreamOptions): Promise<StreamCarrier> {
  const proxy = new URL(normalizeHttpConnectProxyOrigin(options.proxyOrigin));
  normalizeHttpConnectAuthority(options.authority);
  const scope = createOperationScope({ ...options, deadline: Math.min(options.deadline ?? Infinity, Date.now() + HTTP_CONNECT_LIMITS.handshakeTimeoutMs) });
  let socket: Socket | undefined;
  let carrier: StreamCarrier | undefined;
  const cancelled = (): void => { socket?.destroy(); };
  try {
    scope.check();
    const host = proxy.hostname.replace(/^\[|\]$/gu, "");
    const port = Number(proxy.port || (proxy.protocol === "https:" ? 443 : 80));
    socket = proxy.protocol === "https:"
      ? connectTls({ host, port, rejectUnauthorized: true, ...(isIP(host) === 0 ? { servername: host } : {}) })
      : connectTcp({ host, port, allowHalfOpen: true });
    socket.allowHalfOpen = true;
    const selected = socket;
    scope.signal.addEventListener("abort", cancelled, { once: true });
    const event = proxy.protocol === "https:" ? "secureConnect" : "connect";
    let cleanup = (): void => {};
    try {
      await scope.wait(new Promise<void>((resolve, reject) => {
        const ready = (): void => resolve();
        const failed = (error: Error): void => reject(error);
        const closed = (): void => reject(new LinkspanError("transport_error", "The selected HTTP CONNECT proxy closed before connection."));
        cleanup = () => { selected.removeListener(event, ready); selected.removeListener("error", failed); selected.removeListener("close", closed); };
        selected.once(event, ready); selected.once("error", failed); selected.once("close", closed);
      }));
      scope.check();
      carrier = createNodeStreamCarrier(selected, options);
    } finally { cleanup(); }
    return await negotiateHttpConnect(carrier, options);
  } catch (error) {
    const failure = scope.signal.aborted ? asLinkspanError(scope.signal.reason)
      : socket instanceof TLSSocket && socket.authorizationError
        ? new LinkspanError("authentication_failed", "The HTTPS CONNECT proxy certificate was not authenticated.", { cause: error })
        : asLinkspanError(error);
    carrier?.abort(failure);
    socket?.destroy();
    throw failure;
  } finally { scope.signal.removeEventListener("abort", cancelled); scope.dispose(); }
}

/** Absolute UTC milliseconds. Cancellation never implies that a remote effect was undone. */
export interface OperationOptions {
  signal?: AbortSignal;
  deadline?: number;
}

export type LinkspanErrorCode =
  | "invalid_argument"
  | "cancelled"
  | "deadline_exceeded"
  | "closed"
  | "transport_error"
  | "identity_mismatch"
  | "authentication_failed"
  | "protocol_error"
  | "resource_exhausted"
  | "unavailable"
  | "outcome_unknown";

export class LinkspanError extends Error {
  readonly code: LinkspanErrorCode;
  readonly outcome?: "not_sent" | "unknown";

  constructor(
    code: LinkspanErrorCode,
    message: string,
    options: { cause?: unknown; outcome?: "not_sent" | "unknown" } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LinkspanError";
    this.code = code;
    this.outcome = options.outcome;
  }
}

export interface CloseResult {
  error?: LinkspanError;
}

/**
 * A single-owner, ordered, binary channel. Implementations document message and
 * buffering limits. Only one receive operation may be outstanding. A successful
 * send means local transport acceptance, never a remote business receipt.
 * null is an orderly EOF; failure is thrown and is also available through closed.
 */
export interface ByteChannel {
  send(data: Uint8Array, options?: OperationOptions): Promise<void>;
  receive(options?: OperationOptions): Promise<Uint8Array | null>;
  close(): Promise<void>;
  abort(reason?: unknown): void;
  readonly closed: Promise<CloseResult>;
}

/** Keep diagnostics stable and do not copy arbitrary transport messages into them. */
export function asLinkspanError(
  error: unknown,
  fallbackCode: LinkspanErrorCode = "transport_error",
): LinkspanError {
  if (error instanceof LinkspanError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new LinkspanError("cancelled", "The operation was cancelled", { cause: error });
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new LinkspanError("deadline_exceeded", "The operation deadline elapsed", { cause: error });
  }
  return new LinkspanError(fallbackCode, "The connection operation failed", { cause: error });
}

export interface OperationScope {
  readonly signal: AbortSignal;
  check(): void;
  /** Races waiting, not the underlying effect. The owner must cancel that effect. */
  wait<T>(value: PromiseLike<T>): Promise<T>;
  dispose(): void;
}

/**
 * A disposable operation lifetime. It handles already-aborted signals, expired
 * absolute deadlines, long deadlines, and listener/timer cleanup without Node APIs.
 */
export function createOperationScope(options: OperationOptions = {}): OperationScope {
  if (options.deadline !== undefined && !Number.isFinite(options.deadline)) {
    throw new LinkspanError("invalid_argument", "deadline must be finite absolute milliseconds");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const cancel = () => {
    const timedOut = asLinkspanError(options.signal?.reason, "cancelled").code === "deadline_exceeded";
    controller.abort(new LinkspanError(timedOut ? "deadline_exceeded" : "cancelled", timedOut ? "The operation deadline elapsed" : "The operation was cancelled", { cause: options.signal?.reason }));
  };
  const expire = () => {
    if (disposed || options.deadline === undefined) return;
    const remaining = options.deadline - Date.now();
    if (remaining <= 0) {
      controller.abort(new LinkspanError("deadline_exceeded", "The operation deadline elapsed"));
    } else {
      timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
    }
  };
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  if (!controller.signal.aborted) expire();

  const check = () => {
    if (controller.signal.aborted) throw asLinkspanError(controller.signal.reason);
    // An overloaded event loop must not allow work beyond its absolute deadline.
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      controller.abort(new LinkspanError("deadline_exceeded", "The operation deadline elapsed"));
      throw controller.signal.reason;
    }
  };
  return {
    signal: controller.signal,
    check,
    wait<T>(value: PromiseLike<T>): Promise<T> {
      try { check(); } catch (error) {
        // Observe a caller-created promise even when cancellation already won.
        Promise.resolve(value).catch(() => {});
        return Promise.reject(error);
      }
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          reject(asLinkspanError(controller.signal.reason));
        };
        const cleanup = () => controller.signal.removeEventListener("abort", onAbort);
        controller.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(value).then(
          (result) => {
            cleanup();
            try { check(); resolve(result); } catch (error) { reject(error); }
          },
          (error) => { cleanup(); reject(error); },
        );
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
    },
  };
}

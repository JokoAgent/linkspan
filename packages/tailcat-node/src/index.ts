import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LinkspanError, asLinkspanError, createOperationScope } from "@jokoagent/linkspan-core";
import type { OperationOptions, LinkspanErrorCode } from "@jokoagent/linkspan-core";
import { createTailcatRuntimeFromRpc } from "@jokoagent/linkspan-tailcat-runtime";

let configuredDirectory: string | undefined;
export function configureTailcatRuntime(directory: string) {
  if (!isAbsolute(directory)) throw new LinkspanError("invalid_argument", "The prepared tailcat runtime directory must be absolute");
  configuredDirectory = directory;
}

export async function createTailcatRuntime() {
  const directory = configuredDirectory ?? process.env["LINKSPAN_TAILCAT_RUNTIME_DIR"] ?? fileURLToPath(new URL("./runtime", import.meta.url));
  const filename = join(directory, process.platform === "win32" ? "tailcat-helper.exe" : "tailcat-helper");
  try {
    if (!isAbsolute(directory)) throw new Error("A fixed absolute runtime directory is required.");
    const [bytes, receiptText] = await Promise.all([readFile(filename), readFile(join(directory, "tailcat-runtime.json"), "utf8")]);
    const receipt = JSON.parse(receiptText) as { target?: string; sha256?: string; version?: string; bytes?: number };
    if (receipt.target !== `${process.platform}-${process.arch}` || receipt.version !== "0.7.0" || receipt.bytes !== bytes.length || receipt.sha256 !== createHash("sha256").update(bytes).digest("hex")) throw new Error("The target or integrity receipt did not match.");
  } catch (cause) { throw new LinkspanError("unavailable", "The fixed tailcat helper must be prepared and packaged for this target", { cause }); }
  const child = spawn(filename, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...(process.env["SystemRoot"] === undefined ? {} : { SystemRoot: process.env["SystemRoot"] }), ...(process.env["WINDIR"] === undefined ? {} : { WINDIR: process.env["WINDIR"] }) } });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let id = 0;
  let failed = false;
  const fail = () => {
    if (failed) return;
    failed = true;
    for (const entry of pending.values()) entry.reject(new LinkspanError("transport_error", "The managed tailcat binding stopped"));
    pending.clear(); lines.close(); child.kill();
  };
  child.on("error", fail); child.on("exit", fail); child.stdin.on("error", fail);
  // Upstream diagnostic text is deliberately discarded; no node/PSK material is logged.
  child.stderr.on("data", () => {});
  lines.on("line", line => {
    try {
      if (line.length > 512 * 1024) { fail(); return; }
      const reply = JSON.parse(line) as { id: number; result: unknown; error?: string };
      const entry = pending.get(reply.id);
      if (!entry) return;
      pending.delete(reply.id);
      if (reply.error) {
        const known = ["invalid_argument", "identity_mismatch", "closed", "cancelled", "deadline_exceeded", "resource_exhausted", "transport_error"];
        entry.reject(new LinkspanError(known.includes(reply.error) ? reply.error as LinkspanErrorCode : "transport_error", "The managed tailcat operation failed"));
      } else entry.resolve(reply.result);
    } catch { fail(); }
  });
  async function request(method: string, args: Record<string, unknown>, options: OperationOptions = {}) {
    if (failed) throw new LinkspanError("closed", "The managed tailcat binding is closed");
    if (pending.size >= 256) throw new LinkspanError("resource_exhausted", "The managed binding operation limit was reached");
    const scope = createOperationScope(options);
    const requestId = ++id;
    let sent = false;
    const cancel = () => {
      if (!sent || failed) return;
      child.stdin.write(`${JSON.stringify({ id: ++id, method: "cancel", args: { cancelId: requestId } })}\n`);
    };
    scope.signal.addEventListener("abort", cancel, { once: true });
    try {
      scope.check();
      const result = new Promise<unknown>((resolve, reject) => { pending.set(requestId, { resolve, reject }); }).then(value => {
        if (scope.signal.aborted && (method === "connect" || method === "listen") && typeof (value as {handle?: unknown})?.handle === "string") {
          void request(method === "connect" ? "abort" : "closeListener", { handle: (value as {handle:string}).handle }).catch(() => {});
        }
        return value;
      });
      const encoded = `${JSON.stringify({ id: requestId, method, args, ...(options.deadline === undefined ? {} : { deadline: options.deadline }) })}\n`;
      if (encoded.length > 512 * 1024) { pending.delete(requestId); throw new LinkspanError("resource_exhausted", "The managed binding request limit was exceeded"); }
      sent = true;
      await new Promise<void>((resolve, reject) => { child.stdin.write(encoded, error => error ? reject(error) : resolve()); });
      return await scope.wait(result);
    } catch (error) { cancel(); throw asLinkspanError(error); }
    finally { scope.signal.removeEventListener("abort", cancel); scope.dispose(); }
  }
  const runtime = createTailcatRuntimeFromRpc(request);
  return { ...runtime, dispose() { child.stdin.end(); fail(); } };
}

import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, chmod, writeFile } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { createOperationScope, LinkspanError } from "@jokoagent/linkspan-core";
import { HELPER_ARTIFACTS, type HelperArtifact } from "./helper-artifacts.js";
import type { ConnectorHelper } from "./types.js";

function artifact(provider: string, target: string): HelperArtifact {
  const result = HELPER_ARTIFACTS.find(value => value.provider === provider && value.target === target);
  if (!result) throw new LinkspanError("unavailable", "No pinned helper artifact is available for the selected provider and target.");
  return result;
}
export function connectorHelperArtifact(provider: string, target = `${process.platform}-${process.arch}`): Readonly<HelperArtifact> { return Object.freeze({ ...artifact(provider, target) }); }

export async function verifyConnectorHelper(provider: string, helper: ConnectorHelper): Promise<ConnectorHelper> {
  if (!isAbsolute(helper.executable) || helper.target !== `${process.platform}-${process.arch}`) throw new LinkspanError("invalid_argument", "The prepared helper must match this runtime target and use an absolute executable path.");
  const info = await lstat(helper.executable).catch(() => { throw new LinkspanError("unavailable", "The prepared connector helper is missing."); });
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 256 * 1024 * 1024) throw new LinkspanError("authentication_failed", "The connector helper is not a bounded regular release artifact.");
  const hash = createHash("sha256").update(await readFile(helper.executable)).digest("hex");
  if (hash !== helper.sha256) throw new LinkspanError("authentication_failed", "The connector helper does not match its prepared integrity.");
  const sourceVersion = { rathole: "rathole-source-0.5.0", bore: "bore-source-0.6.0", zrok: "zrok-source-2.0.8" } as const;
  const builtFromSource = Object.hasOwn(sourceVersion, provider) && helper.version === sourceVersion[provider as keyof typeof sourceVersion];
  if (!["funnel", "netbird", "pangolin"].includes(provider) && !builtFromSource) {
    const expected = artifact(provider, helper.target);
    if (expected.version !== helper.version || expected.binarySha256 !== hash || expected.binaryBytes !== info.size) throw new LinkspanError("authentication_failed", "The connector helper does not match the fixed upstream release.");
  } else {
    // Embedded helpers carry the build receipt produced from their fixed Go
    // module and source inputs. The host pins this receipt with its release.
    const manifest = JSON.parse(await readFile(join(dirname(helper.executable), "helper-build.json"), "utf8")) as { provider?: string; version?: string; target?: string; sha256?: string; bytes?: number };
    if (manifest.provider !== provider || manifest.version !== helper.version || manifest.target !== helper.target || manifest.sha256 !== hash || manifest.bytes !== info.size) throw new LinkspanError("authentication_failed", "The embedded helper does not match its fixed build receipt.");
  }
  return Object.freeze({ ...helper });
}

/** Explicit release/build preparation only. No connector startup calls this. */
export async function prepareConnectorHelper(options: { readonly provider: string; readonly directory: string; readonly target?: string; readonly goExecutable?: string; readonly cargoExecutable?: string; readonly rustcExecutable?: string; readonly signal?: AbortSignal }): Promise<ConnectorHelper> {
  if (!isAbsolute(options.directory)) throw new LinkspanError("invalid_argument", "Helper preparation requires an absolute release directory.");
  const target = options.target ?? `${process.platform}-${process.arch}`;
  if (options.provider === "zrok" || (["rathole", "bore"].includes(options.provider) && !HELPER_ARTIFACTS.some(value => value.provider === options.provider && value.target === target))) {
    const source = new URL("../scripts/build-source-helper.mjs", import.meta.url).href;
    const builder = await import(source) as { buildSourceHelper(options: object): Promise<{ executable: string; manifestPath: string }> };
    const result = await builder.buildSourceHelper({ ...options, target });
    const receipt = JSON.parse(await readFile(result.manifestPath, "utf8")) as { version: string; sha256: string };
    return Object.freeze({ executable: result.executable, target, version: receipt.version, sha256: receipt.sha256 });
  }
  if (["funnel", "netbird", "pangolin"].includes(options.provider)) {
    const source = new URL("../scripts/build-embedded-helper.mjs", import.meta.url).href;
    const builder = await import(source) as { buildEmbeddedHelper(options: object): Promise<{ executable: string; manifestPath: string }> };
    const result = await builder.buildEmbeddedHelper({ ...options, target });
    const receipt = JSON.parse(await readFile(result.manifestPath, "utf8")) as { version: string; sha256: string };
    return Object.freeze({ executable: result.executable, target, version: receipt.version, sha256: receipt.sha256 });
  }
  const selected = artifact(options.provider, target);
  const directory = join(options.directory, options.provider, selected.version, target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const executable = join(directory, `${options.provider}${target.startsWith("win32-") ? ".exe" : ""}`);
  const result = { executable, target, version: selected.version, sha256: selected.binarySha256 };
  const existing = await lstat(executable).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; });
  if (existing) {
    const info = await lstat(executable);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== selected.binaryBytes || createHash("sha256").update(await readFile(executable)).digest("hex") !== selected.binarySha256) throw new LinkspanError("authentication_failed", "An existing helper artifact failed its pinned integrity.");
    return Object.freeze(result);
  }
  const scope = createOperationScope({ ...(options.signal === undefined ? {} : { signal: options.signal }), deadline: Date.now() + 180_000 });
  const temporary = await mkdtemp(join(directory, ".prepare-"));
  const archivePath = join(temporary, "source.archive");
  const staging = join(temporary, "extract");
  try {
    scope.check();
    const response = await fetch(selected.url, { signal: scope.signal, redirect: "follow" });
    if (!response.ok || !response.body) throw new LinkspanError("unavailable", "The fixed helper release could not be fetched.");
    const chunks: Uint8Array[] = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.byteLength; if (length > selected.archiveBytes) throw new Error(); chunks.push(chunk); }
    const archive = Buffer.concat(chunks);
    if (length !== selected.archiveBytes || createHash("sha256").update(archive).digest("hex") !== selected.archiveSha256) throw new LinkspanError("authentication_failed", "The downloaded helper release failed its pinned integrity.");
    let binary: Uint8Array;
    if (selected.format === "zip") {
      const packageName = "fflate";
      const { unzipSync } = await import(packageName) as { unzipSync(data: Uint8Array, options: { filter(entry: { name: string; originalSize: number }): boolean }): Record<string, Uint8Array> };
      const files = unzipSync(archive, { filter: entry => entry.name === selected.entry && entry.originalSize === selected.binaryBytes });
      const value = files[selected.entry];
      if (!value) throw new Error();
      binary = value;
    } else {
      await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
      await mkdir(staging, { mode: 0o700 });
      const packageName = "tar";
      const { x } = await import(packageName) as { x(options: object): Promise<void> };
      await x({ file: archivePath, cwd: staging, strict: true, preservePaths: false, noMtime: true, filter: (path: string, entry: { type: string; size: number }) => path === selected.entry && entry.type === "File" && entry.size === selected.binaryBytes });
      const extracted = join(staging, selected.entry);
      const info = await lstat(extracted);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== selected.binaryBytes) throw new Error();
      binary = await readFile(extracted);
    }
    if (binary.byteLength !== selected.binaryBytes || createHash("sha256").update(binary).digest("hex") !== selected.binarySha256) throw new LinkspanError("authentication_failed", "The helper executable failed its fixed release integrity.");
    scope.check();
    await writeFile(executable, binary, { flag: "wx", mode: 0o700 });
    await chmod(executable, 0o700);
    await writeFile(join(directory, "upstream.json"), JSON.stringify(selected, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return Object.freeze(result);
  } finally {
    scope.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
}

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { lstat, mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { LinkspanError } from "@jokoagent/linkspan-core";
import { PINGGY_NATIVE_ARTIFACTS, PINGGY_SOURCES, PINGGY_SDK_VERSION } from "./artifacts.js";

const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
function artifact(target: string, abi: string) {
  const result = PINGGY_NATIVE_ARTIFACTS.find(value => value.target === target && value.abi === abi);
  if (!result) throw new LinkspanError("unavailable", "This Pinggy release has no pinned addon for the selected runtime ABI and target. Build a matching release before enabling it.");
  return result;
}
export async function verifyPinggySdk(directory: string): Promise<void> {
  if (!isAbsolute(directory)) throw new LinkspanError("invalid_argument", "A prepared absolute Pinggy SDK directory is required.");
  const selected = artifact(`${process.platform}-${process.arch}`, process.versions.modules);
  for (const file of [...PINGGY_SOURCES, ...selected.files]) {
    const path = join(directory, file.path); const info = await lstat(path).catch(() => { throw new LinkspanError("unavailable", "The selected Pinggy SDK target has not been prepared."); });
    if (!info.isFile() || info.isSymbolicLink() || info.size !== file.bytes || digest(await readFile(path)) !== file.sha256) throw new LinkspanError("authentication_failed", "The prepared Pinggy SDK does not match its pinned source and native target.");
  }
}

/** Do not enable upstream install scripts. This explicitly fetches one fixed ABI
 * archive, verifies every executable/library and copies only the pinned SDK JS.
 * Runtime never downloads native code or falls back to another architecture. */
export async function preparePinggySdk(options: { readonly directory: string; readonly target?: string; readonly nodeAbi?: string; readonly signal?: AbortSignal }): Promise<{ readonly sdkDirectory: string; readonly target: string; readonly nodeAbi: string; readonly version: string }> {
  if (!isAbsolute(options.directory)) throw new LinkspanError("invalid_argument", "An absolute release preparation directory is required.");
  const target = options.target ?? `${process.platform}-${process.arch}`;
  const abi = options.nodeAbi ?? process.versions.modules;
  const selected = artifact(target, abi);
  const directory = join(options.directory, `pinggy-${PINGGY_SDK_VERSION}`, target, `node-${abi}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(directory, ".prepare-"));
  try {
    options.signal?.throwIfAborted();
    const response = await fetch(selected.url, { signal: options.signal ?? AbortSignal.timeout(180_000) });
    if (!response.ok || !response.body) throw new Error();
    let bytes = 0; const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > selected.bytes) throw new Error(); chunks.push(chunk); }
    const archive = Buffer.concat(chunks);
    if (bytes !== selected.bytes || digest(archive) !== selected.sha256) throw new LinkspanError("authentication_failed", "The Pinggy native archive failed its pinned integrity.");
    const archivePath = join(temporary, "addon.tgz"); await writeFile(archivePath, archive, { flag: "wx", mode: 0o600 });
    const tarName = "tar"; const tar = await import(tarName) as { x(options: object): Promise<void> };
    await tar.x({ file: archivePath, cwd: temporary, strict: true, preservePaths: false, filter: (path: string, entry: { type: string; size: number }) => selected.files.some(file => file.path === path && entry.type === "File" && file.bytes === entry.size) });
    for (const file of selected.files) { const content = await readFile(join(temporary, file.path)); if (content.length !== file.bytes || digest(content) !== file.sha256) throw new Error(); }
    const sourceRoot = dirname(createRequire(import.meta.url).resolve("@pinggy/pinggy/package.json"));
    for (const file of PINGGY_SOURCES) { const content = await readFile(join(sourceRoot, file.path)); if (content.length !== file.bytes || digest(content) !== file.sha256) throw new LinkspanError("authentication_failed", "The installed Pinggy SDK source differs from the selected release."); await mkdir(dirname(join(directory, file.path)), { recursive: true }); await writeFile(join(directory, file.path), content, { mode: 0o600 }); }
    for (const file of selected.files) { const path = join(directory, file.path); await mkdir(dirname(path), { recursive: true }); await copyFile(join(temporary, file.path), path); }
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "linkspan-prepared-pinggy-sdk", version: PINGGY_SDK_VERSION, type: "module", private: true }) + "\n");
    await copyFile(join(sourceRoot, "LICENSE"), join(directory, "LICENSE.pinggy-sdk"));
    await writeFile(join(directory, "prepared.json"), JSON.stringify({ version: PINGGY_SDK_VERSION, target, nodeAbi: abi, archive: selected, javascript: PINGGY_SOURCES }, null, 2) + "\n");
    return Object.freeze({ sdkDirectory: directory, target, nodeAbi: abi, version: PINGGY_SDK_VERSION });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

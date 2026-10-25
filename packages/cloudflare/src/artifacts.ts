import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CLOUDFLARED_VERSION = "2026.10.3-linkspan.1";
export const CLOUDFLARED_COMMIT = "de6376c5af4a67cbc65258682e5a01781827643d";
export type CloudflaredTarget = "win32-x64" | "linux-x64" | "linux-arm64" | "darwin-x64" | "darwin-arm64";

export class CloudflareConnectorError extends Error {
  constructor(readonly code: "invalid_input" | "unsupported_platform" | "integrity" | "cancelled" | "deadline" | "unavailable" | "closed" | "cleanup_failed", message: string) {
    super(message);
    this.name = "CloudflareConnectorError";
  }
}

export interface CloudflaredArtifact {
  readonly version: typeof CLOUDFLARED_VERSION;
  readonly target: CloudflaredTarget;
  readonly sourceUrl: string;
  readonly sourceBytes: number;
  readonly sourceSha256: string;
  readonly binaryBytes: number;
  readonly binarySha256: string;
}

const ARTIFACTS: Record<CloudflaredTarget, Pick<CloudflaredArtifact, "binaryBytes" | "binarySha256">> = {
  "win32-x64": { binaryBytes: 40115200, binarySha256: "9d23f8b8bee69f4db958a59e44480a9d49242e1e50264ecb1de49428639ee360" },
  "linux-x64": { binaryBytes: 40104141, binarySha256: "7e0373c8786337d2babc809cf0e5ce8ab365c12782dfab89299271a34f83c694" },
  "linux-arm64": { binaryBytes: 37499101, binarySha256: "6b5693dcbf0d712cff5657eb97fe68e484bbcfe4bfa2efff336ac49777472f55" },
  "darwin-x64": { binaryBytes: 41248368, binarySha256: "14e9b5dd552cbe488207010232298b78e3bcbd846740cc5ac002c1df5f2a2efb" },
  "darwin-arm64": { binaryBytes: 39053522, binarySha256: "873c1903c21639879653cdc5a9c2dd8dfd06f0571daf518ae45950512d819930" }
};

/** Pure metadata lookup. This never downloads, probes or starts a backend. */
export function cloudflaredArtifact(target: string = `${process.platform}-${process.arch}`): CloudflaredArtifact {
  if (!Object.hasOwn(ARTIFACTS, target)) throw new CloudflareConnectorError("unsupported_platform", "The pinned cloudflared release has no supported artifact for this target.");
  const value = ARTIFACTS[target as CloudflaredTarget];
  return Object.freeze({ ...value, version: CLOUDFLARED_VERSION, target: target as CloudflaredTarget,
    sourceUrl: `https://codeload.github.com/cloudflare/cloudflared/tar.gz/${CLOUDFLARED_COMMIT}`,
    sourceBytes: 651992, sourceSha256: "6c6901ae333508e1c529184bf90cb87ff59592620d293401db38415269908311" });
}

export interface ManagedCloudflaredHelper {
  readonly executable: string;
  readonly version: typeof CLOUDFLARED_VERSION;
  readonly target: CloudflaredTarget;
  readonly sha256: string;
  readonly bytes: number;
}

/** Checks a regular file against the built-in release manifest, not caller-provided hashes. */
export async function verifyCloudflared(options: { readonly executable: string; readonly target?: string; readonly signal?: AbortSignal }): Promise<ManagedCloudflaredHelper> {
  const artifact = cloudflaredArtifact(options.target);
  if (!isAbsolute(options.executable)) throw new CloudflareConnectorError("invalid_input", "The managed helper path must be absolute.");
  options.signal?.throwIfAborted();
  const info = await lstat(options.executable).catch(() => { throw new CloudflareConnectorError("integrity", "The managed cloudflared helper is unavailable."); });
  if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.binaryBytes) throw new CloudflareConnectorError("integrity", "The managed cloudflared helper does not match its pinned release.");
  const hash = createHash("sha256");
  let received = 0;
  for await (const bytes of createReadStream(options.executable, options.signal === undefined ? {} : { signal: options.signal })) {
    received += bytes.byteLength;
    if (received > artifact.binaryBytes) throw new CloudflareConnectorError("integrity", "The managed cloudflared helper exceeded its pinned size.");
    hash.update(bytes);
  }
  if (hash.digest("hex") !== artifact.binarySha256) throw new CloudflareConnectorError("integrity", "The managed cloudflared helper does not match its pinned release.");
  options.signal?.throwIfAborted();
  return Object.freeze({ executable: options.executable, version: CLOUDFLARED_VERSION, target: artifact.target, sha256: artifact.binarySha256, bytes: artifact.binaryBytes });
}

/** Explicit build-time preparation. Runtime startup never calls this function. */
export async function prepareCloudflared(options: { readonly directory: string; readonly target?: string; readonly signal?: AbortSignal; readonly goExecutable?: string }): Promise<ManagedCloudflaredHelper> {
  const artifact = cloudflaredArtifact(options.target);
  if (!isAbsolute(options.directory)) throw new CloudflareConnectorError("invalid_input", "The helper preparation directory must be absolute.");
  options.signal?.throwIfAborted();
  const directory = resolve(options.directory, CLOUDFLARED_VERSION, artifact.target);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const executable = join(directory, artifact.target.startsWith("win32-") ? "cloudflared.exe" : "cloudflared");
  if (await lstat(executable).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error; })) {
    const result = await verifyCloudflared({ executable, target: artifact.target, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    await preserveSourceMaterials(directory, artifact);
    return result;
  }
  // The unmodified upstream binary accepts platform-selected arbitrary TCP
  // destinations and remote ingress replacement. Only the pinned restricted
  // build is allowed, including when a host supplies an executable override.
  const builder = await import(new URL("../scripts/build-restricted-helper.mjs", import.meta.url).href) as {
    buildRestrictedHelper(input: { directory: string; target: string; signal?: AbortSignal; goExecutable?: string }): Promise<unknown>;
  };
  await builder.buildRestrictedHelper({ directory, target: artifact.target,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.goExecutable === undefined ? {} : { goExecutable: options.goExecutable }) });
  const prepared = await verifyCloudflared({ executable, target: artifact.target, ...(options.signal === undefined ? {} : { signal: options.signal }) });
  await preserveSourceMaterials(directory, artifact);
  return prepared;
}

async function preserveSourceMaterials(directory: string, artifact: CloudflaredArtifact): Promise<void> {
  const materials = ["LICENSE.cloudflared", "UPSTREAM.md", "THIRD_PARTY_NOTICES.cloudflared.md", "cloudflared.build-inputs.json", "cloudflared-restricted.patch"];
  for (const name of materials) {
    const content = await readFile(fileURLToPath(new URL(`../${name}`, import.meta.url)));
    await createMaterial(join(directory, name), content);
  }
  await createMaterial(join(directory, "cloudflared.source.json"), Buffer.from(`${JSON.stringify({ ...artifact, commit: CLOUDFLARED_COMMIT }, null, 2)}\n`));
}

async function createMaterial(path: string, content: Uint8Array): Promise<void> {
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !(await readFile(path)).equals(content)) throw new CloudflareConnectorError("integrity", "An existing helper source material does not match the pinned input.");
  }
}

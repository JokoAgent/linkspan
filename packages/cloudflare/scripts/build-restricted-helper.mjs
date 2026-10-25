import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t as listTar, x as extractTar } from 'tar';

const run = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const RESTRICTED_HELPER_VERSION = '2026.10.3-linkspan.1';
export const SOURCE_COMMIT = 'de6376c5af4a67cbc65258682e5a01781827643d';
export const SOURCE_URL = `https://codeload.github.com/cloudflare/cloudflared/tar.gz/${SOURCE_COMMIT}`;
export const SOURCE_BYTES = 651992;
export const SOURCE_SHA256 = '6c6901ae333508e1c529184bf90cb87ff59592620d293401db38415269908311';
const targets = { 'win32-x64': ['windows', 'amd64'], 'linux-x64': ['linux', 'amd64'], 'linux-arm64': ['linux', 'arm64'], 'darwin-x64': ['darwin', 'amd64'], 'darwin-arm64': ['darwin', 'arm64'] };

/** Explicit build preparation only. No downloaded or upstream executable runs. */
export async function buildRestrictedHelper({ directory, target = `${process.platform}-${process.arch}`, goExecutable = process.env.LINKSPAN_GO_EXECUTABLE ?? 'go', signal, runTests = true }) {
  if (!isAbsolute(directory) || !Object.hasOwn(targets, target)) throw new Error('An absolute build directory and a supported target are required.');
  signal?.throwIfAborted();
  const { stdout } = await run(goExecutable, ['version'], { signal, windowsHide: true });
  if (!/^go version go1\.27\.3 /u.test(stdout)) throw new Error('The restricted helper requires the pinned Go 1.27.3 toolchain.');
  await mkdir(directory, { recursive: true });
  const staging = await mkdtemp(join(directory, '.build-'));
  try {
    const archive = join(staging, 'source.tar.gz');
    const response = await fetch(SOURCE_URL, { signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]) });
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('The pinned helper source could not be downloaded.'); }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    try {
      for (;;) {
        const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > SOURCE_BYTES) throw new Error('The helper source exceeded its pinned size.');
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const bytes = Buffer.concat(chunks);
    if (size !== SOURCE_BYTES || createHash('sha256').update(bytes).digest('hex') !== SOURCE_SHA256) throw new Error('The helper source does not match the pinned commit archive.');
    await writeFile(archive, bytes, { flag: 'wx' });
    const source = join(staging, 'source'); await mkdir(source);
    await listTar({ file: archive, strict: true, onReadEntry(entry) {
      if (!['File', 'Directory'].includes(entry.type) || !entry.path.startsWith(`cloudflared-${SOURCE_COMMIT}/`) || entry.path.split('/').includes('..')) throw new Error('Unexpected helper source archive entry.');
    } });
    await extractTar({ file: archive, cwd: source, strip: 1, strict: true });
    const patch = join(packageRoot, 'cloudflared-restricted.patch');
    await run('git', ['init', '--quiet'], { cwd: source, signal, windowsHide: true });
    await run('git', ['apply', '--check', patch], { cwd: source, signal, windowsHide: true });
    await run('git', ['apply', patch], { cwd: source, signal, windowsHide: true });
    await copyFile(join(packageRoot, 'scripts', 'restricted-http2-test.go'), join(source, 'connection', 'linkspan_restricted_test.go'));
    await copyFile(join(packageRoot, 'scripts', 'restricted-origin-test.go'), join(source, 'proxy', 'linkspan_restricted_test.go'));
    await copyFile(join(packageRoot, 'scripts', 'restricted-tls-test.go'), join(source, 'ingress', 'linkspan_restricted_test.go'));
    const environment = { ...process.env, GOTOOLCHAIN: 'local', GOENV: 'off', CGO_ENABLED: '0', GOFLAGS: '', GOWORK: 'off', GOFIPS140: 'off', GOEXPERIMENT: '', GOAMD64: 'v1', GOARM64: 'v8.0' };
    let testOutput;
    if (runTests) ({ stdout: testOutput } = await run(goExecutable, ['test', '-v', '-p=4', '-mod=readonly', '-run', '^TestLinkspanRestricted', '-count=1', './connection', './proxy', './ingress'], { cwd: source, signal, env: environment, windowsHide: true, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 }));
    const [GOOS, GOARCH] = targets[target];
    const executable = join(directory, target.startsWith('win32-') ? 'cloudflared.exe' : 'cloudflared');
    const built = join(staging, target.startsWith('win32-') ? 'cloudflared.exe' : 'cloudflared');
    const arguments_ = ['build', '-p=4', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags', `-buildid= -X main.Version=${RESTRICTED_HELPER_VERSION} -X main.BuildTime=2026-10-25T00:00:00Z`, '-o', built, './cmd/cloudflared'];
    await run(goExecutable, arguments_, { cwd: source, signal, env: { ...environment, GOOS, GOARCH }, windowsHide: true, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
    const binary = await readFile(built);
    const receipt = { version: RESTRICTED_HELPER_VERSION, sourceCommit: SOURCE_COMMIT, sourceSha256: SOURCE_SHA256, patchSha256: createHash('sha256').update(await readFile(patch)).digest('hex'), toolchain: 'go1.27.3', target, bytes: binary.length, sha256: createHash('sha256').update(binary).digest('hex'), arguments: arguments_, ...(testOutput ? { tests: testOutput.trim() } : {}) };
    await copyFile(built, executable, 1); await chmod(executable, 0o700);
    await writeFile(join(directory, 'restricted-helper.build.json'), JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
    return { executable, ...receipt };
  } finally {
    const owned = relative(directory, staging);
    if (owned && !owned.startsWith('..') && !isAbsolute(owned)) await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildRestrictedHelper({ directory: resolve(process.argv[2] ?? '.runtime/restricted-helper'), target: process.argv[3], goExecutable: process.env.LINKSPAN_GO_EXECUTABLE ?? 'go' });
  process.stdout.write(JSON.stringify(result) + '\n');
}

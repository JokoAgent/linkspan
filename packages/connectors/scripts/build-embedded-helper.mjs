import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const versions = { funnel: 'tailscale.com@v1.104.2', netbird: 'github.com/netbirdio/netbird@v0.81.4' };
const targets = new Set(['win32-x64','win32-arm64','linux-x64','linux-arm64','darwin-x64','darwin-arm64']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

/** Build only the explicitly selected embedded SDK and target, never at runtime. */
export async function buildEmbeddedHelper({ provider, directory, target = `${process.platform}-${process.arch}`,
  goExecutable = process.env.LINKSPAN_GO_EXECUTABLE ?? 'go', signal }) {
  if (provider === 'pangolin') {
    const { buildPangolinHelper } = await import('./build-pangolin-helper.mjs');
    return buildPangolinHelper({ directory, target, goExecutable, signal });
  }
  if (!Object.hasOwn(versions, provider) || !isAbsolute(directory) || !targets.has(target)) throw new Error('Invalid embedded connector build selection.');
  const { stdout: toolchain } = await run(goExecutable, ['version'], { windowsHide: true, signal });
  if (!/^go version go1\.27\.3 /u.test(toolchain)) throw new Error('Embedded connectors require the pinned Go 1.27.3 toolchain.');
  const source = join(root, 'helpers', provider);
  const output = join(directory, `${provider}-embedded-1`, target);
  await mkdir(output, { recursive: true });
  const [platform, arch] = target.split('-');
  const environment = { ...process.env, GOTOOLCHAIN: 'local', GOENV: 'off', GOWORK: 'off', GOFLAGS: '', GOEXPERIMENT: '', GOFIPS140: 'off', GOAMD64: 'v1', GOARM64: 'v8.0', GOOS: platform === 'win32' ? 'windows' : platform,
    GOARCH: arch === 'x64' ? 'amd64' : arch, CGO_ENABLED: '0' };
  const executable = join(output, target.startsWith('win32-') ? `linkspan-${provider}.exe` : `linkspan-${provider}`);
  const arguments_ = ['build', '-mod=readonly', '-trimpath', '-buildvcs=false', '-ldflags=-s -w', '-o', executable, '.'];
  await run(goExecutable, arguments_, { cwd: source, env: environment, windowsHide: true, signal, maxBuffer: 8*1024*1024 });
  const { stdout: modulesJson } = await run(goExecutable, ['list','-mod=readonly','-deps','-json','.'], {
    cwd: source, env: environment, windowsHide: true, signal, maxBuffer: 32*1024*1024
  });
  // go list emits concatenated JSON objects. Each top-level record begins at column zero.
  const packages = modulesJson.trim().split(/\r?\n(?=\{)/u).map(value => JSON.parse(value));
  const modules = new Map();
  for (const pkg of packages) if (pkg.Module?.Dir && !pkg.Module.Main && !pkg.Module.Path.startsWith('linkspan.invalid/')) {
    const actual = pkg.Module.Replace ?? pkg.Module;
    modules.set(pkg.Module.Path, { ...actual, Dir: actual.Dir ?? pkg.Module.Dir,
      ...(pkg.Module.Replace === undefined ? {} : { Replaces: pkg.Module.Path }) });
  }
  const notices = [];
  for (const module of [...modules.values()].sort((a,b) => a.Path.localeCompare(b.Path))) {
    const texts = [];
    for (const filename of await readdir(module.Dir)) {
      if (!/^(?:licen[cs]e|copying|notice|copyright)(?:[._-][a-z0-9_.-]+)?$/iu.test(filename)) continue;
      try { const value = await readFile(join(module.Dir, filename), 'utf8'); texts.push(`--- ${filename} ---\n${value}`); } catch {}
    }
    if (texts.length === 0) throw new Error(`A selected upstream module has no preserved root license: ${module.Path}`);
    notices.push(`=== ${module.Path} ${module.Version ?? ''} ${module.Sum ?? ''} ===\n${texts.join('\n')}`);
  }
  await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n\n')+'\n');
  const binary = await readFile(executable);
  const sources = {};
  const inputs = [`helpers/${provider}/go.mod`, `helpers/${provider}/go.sum`, 'helpers/common/go.mod', 'scripts/build-embedded-helper.mjs'];
  for (const folder of [`helpers/${provider}`, 'helpers/common']) for (const filename of await readdir(join(root, folder))) if (filename.endsWith('.go')) inputs.push(`${folder}/${filename}`);
  for (const relative of inputs.sort()) {
    sources[relative] = sha(await readFile(join(root, relative)));
  }
  const manifestPath = join(output, 'helper-build.json');
  await writeFile(manifestPath, JSON.stringify({ provider, version: `${provider}-embedded-1`, upstream: versions[provider], target,
    toolchain: toolchain.trim(), arguments: arguments_, sources, bytes: binary.length, sha256: sha(binary),
    modules: [...modules.values()].map(module => ({ path: module.Path, version: module.Version, sum: module.Sum })) }, null, 2)+'\n');
  return { executable, manifestPath, target, version: `${provider}-embedded-1`, sha256: sha(binary) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildEmbeddedHelper({ provider: process.argv[2], directory: resolve(process.argv[3] ?? '.runtime/embedded-helpers'), target: process.argv[4] ?? `${process.platform}-${process.arch}` });
  console.log(JSON.stringify(result));
}

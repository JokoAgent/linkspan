import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t as listTar } from 'tar';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root, encoding: 'utf8' }).trim();
const clean = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() === '';
if (!clean) throw new Error('Commit the source before producing fixed consumer artifacts.');
const destination = resolve(process.argv[2] ?? join(root, '.runtime', 'packages', sourceCommit));
await mkdir(destination, { recursive: true });
if (!process.env.npm_execpath) throw new Error('Run through pnpm pack:artifacts so the pinned package manager is used.');
const packageManager = /\.[cm]?js$/iu.test(process.env.npm_execpath)
  ? { executable: process.execPath, args: [process.env.npm_execpath] }
  : { executable: process.env.npm_execpath, args: [] };
const packages = [];
for (const name of (await readdir(join(root, 'packages'))).sort()) {
  const directory = join(root, 'packages', name);
  const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  await writeFile(join(directory, 'dist', 'source-build.json'), JSON.stringify({ sourceCommit, sourceTree, name: manifest.name }) + '\n');
  execFileSync(packageManager.executable, [...packageManager.args, 'pack', '--pack-destination', destination], { cwd: directory, stdio: 'inherit' });
  const filename = `${manifest.name.replace('@', '').replace('/', '-')}-${manifest.version}.tgz`;
  const entries = [];
  let packedManifest;
  await listTar({ file: join(destination, filename), strict: true, onReadEntry(entry) {
    entries.push(entry.path);
    if (entry.path === 'package/package.json') {
      const chunks = [];
      entry.on('data', chunk => chunks.push(chunk));
      entry.on('end', () => { packedManifest = JSON.parse(Buffer.concat(chunks).toString('utf8')); });
    }
  } });
  assert.equal(packedManifest?.name, manifest.name);
  assert.equal(packedManifest?.version, manifest.version);
  const targets = [];
  const collect = value => {
    if (typeof value === 'string' && value.startsWith('./')) targets.push(value);
    else if (value && typeof value === 'object') for (const nested of Object.values(value)) collect(nested);
  };
  collect(packedManifest.exports);
  assert.ok(targets.length > 0, 'Every consumer package must have a real public entry.');
  for (const target of targets) assert.ok(entries.includes(`package/${target.slice(2)}`), `Missing packed entry: ${manifest.name} ${target}`);
  assert.equal(entries.some(entry => /(?:\.exe$|\.node$|node_modules\/|\/target\/)/u.test(entry)), false,
    'Native packages contain explicit target builders, never a default collection of platform binaries.');
  if (name.endsWith('-wasm') || name === 'iroh-services') assert.ok(entries.some(entry => entry.endsWith('.wasm')), 'Selected WASM runtimes must contain their built trusted artifact.');
  else assert.equal(entries.some(entry => entry.endsWith('.wasm')), false, 'Only the independently selected browser runtime carries WASM.');
  if (name === 'core' || name === 'noise') {
    const nativeEntry = packedManifest.exports?.['.']?.['react-native'];
    assert.equal(typeof nativeEntry, 'string');
    assert.equal(nativeEntry, packedManifest.exports['.'].import);
    assert.ok(nativeEntry.startsWith('./dist/'));
    assert.ok(entries.includes(`package/${nativeEntry.slice(2)}`), 'The public native entry must exist inside the fixed package.');
  }
  if (name === 'core') assert.deepEqual(packedManifest.dependencies ?? {}, {});
  if (name === 'http') {
    assert.deepEqual(packedManifest.dependencies, { '@jokoagent/linkspan-core': manifest.version });
    assert.equal(entries.some(entry => /connect-parser|CONNECT_PARSER_LICENSE|http-connect/u.test(entry)), false,
      'An HTTP-only archive must not contain the separately selected CONNECT backend.');
  }
  if (name === 'http-connect') {
    assert.deepEqual(packedManifest.dependencies, { '@jokoagent/linkspan-core': manifest.version });
    for (const required of ['connect-parser.js', 'CONNECT_PARSER_LICENSE.txt', 'connect-parser-input.json']) assert.ok(entries.includes(`package/dist/${required}`));
  }
  if (name === 'noise') {
    assert.deepEqual(packedManifest.dependencies, { '@jokoagent/linkspan-core': manifest.version });
    assert.ok(entries.includes('package/dist/THIRD_PARTY_LICENSES.txt'));
    assert.ok(entries.includes('package/dist/dependency-inventory.json'));
  }
  if (name === 'webrtc-node') {
    assert.equal(packedManifest.dependencies?.werift, undefined);
    assert.ok(entries.includes('package/dist/THIRD_PARTY_LICENSES.txt'));
    assert.ok(entries.includes('package/dist/dependency-inventory.json'));
    assert.ok(entries.includes('package/dist/upstream-patches.json'));
  }
  if (name === 'localtunnel') {
    assert.equal(packedManifest.dependencies?.localtunnel, undefined);
    for (const required of ['client.cjs', 'THIRD_PARTY_LICENSES.txt', 'dependency-inventory.json', 'upstream-patches.json']) assert.ok(entries.includes(`package/dist/${required}`));
  }
  if (name === 'cloudflare') {
    for (const required of ['LICENSE.cloudflared', 'UPSTREAM.md', 'THIRD_PARTY_NOTICES.cloudflared.md', 'cloudflared.build-inputs.json',
      'cloudflared-restricted.patch', 'scripts/build-restricted-helper.mjs', 'scripts/restricted-http2-test.go', 'scripts/restricted-origin-test.go', 'scripts/restricted-tls-test.go', 'dist/turn.js', 'dist/turn.d.ts']) assert.ok(entries.includes(`package/${required}`));
    assert.equal(packedManifest.exports['./turn'].import, './dist/turn.js');
  }
  const bytes = await readFile(join(destination, filename));
  packages.push({ name: manifest.name, version: manifest.version, file: filename, bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    runtime: name.endsWith('-wasm') ? 'browser' : name === 'iroh-services' ? 'server-wasm' : name === 'webrtc-node' ? 'node' : name.endsWith('-node') ? 'node-builder' : 'portable' });
}
await writeFile(join(destination, 'manifest.json'), JSON.stringify({ sourceRepository: 'https://github.com/JokoAgent/linkspan', sourceCommit, sourceTree, packages }, null, 2) + '\n');
// Verify the actual installation tree as well as the package manifest: a core
// consumer must not download an adapter, SDK, helper or another platform payload.
const consumer = await mkdtemp(join(tmpdir(), 'linkspan-core-consumer-'));
try {
  const core = packages.find(value => value.name === '@jokoagent/linkspan-core');
  const overrides = Object.fromEntries(packages.map(artifact => [artifact.name, `file:${join(destination, artifact.file).replaceAll('\\', '/')}`]));
  await writeFile(join(consumer, 'pnpm-workspace.yaml'), `overrides:\n${Object.entries(overrides).map(([name, file]) => `  ${JSON.stringify(name)}: ${JSON.stringify(file)}`).join('\n')}\n`);
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
    [core.name]: `file:${join(destination, core.file).replaceAll('\\', '/')}`
  } }));
  execFileSync(packageManager.executable, [...packageManager.args, 'install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: consumer, stdio: 'inherit' });
  const tree = JSON.parse(execFileSync(packageManager.executable, [...packageManager.args, 'list', '--depth', 'Infinity', '--json'], { cwd: consumer, encoding: 'utf8' }));
  assert.deepEqual(Object.keys(tree[0].dependencies), [core.name]);
  assert.deepEqual(tree[0].dependencies[core.name].dependencies ?? {}, {});
  execFileSync(process.execPath, ['--input-type=module', '-e', 'const core = await import("@jokoagent/linkspan-core"); if (typeof core.createOperationScope !== "function") process.exit(1)'], { cwd: consumer, stdio: 'inherit' });
  const http = packages.find(value => value.name === '@jokoagent/linkspan-http');
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [http.name]: overrides[http.name] } }));
  execFileSync(packageManager.executable, [...packageManager.args, 'install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: consumer, stdio: 'inherit' });
  const httpTree = JSON.parse(execFileSync(packageManager.executable, [...packageManager.args, 'list', '--depth', 'Infinity', '--json'], { cwd: consumer, encoding: 'utf8' }));
  assert.deepEqual(Object.keys(httpTree[0].dependencies), [http.name]);
  assert.deepEqual(Object.keys(httpTree[0].dependencies[http.name].dependencies ?? {}), [core.name]);
  assert.deepEqual(httpTree[0].dependencies[http.name].dependencies[core.name].dependencies ?? {}, {});
  execFileSync(process.execPath, ['--input-type=module', '-e', 'const http = await import("@jokoagent/linkspan-http"); if (typeof http.createHttpFetch !== "function") process.exit(1)'], { cwd: consumer, stdio: 'inherit' });
  const httpConnect = packages.find(value => value.name === '@jokoagent/linkspan-http-connect');
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [httpConnect.name]: overrides[httpConnect.name] } }));
  execFileSync(packageManager.executable, [...packageManager.args, 'install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: consumer, stdio: 'inherit' });
  execFileSync(process.execPath, ['--input-type=module', '-e', 'const portable = await import("@jokoagent/linkspan-http-connect"); const node = await import("@jokoagent/linkspan-http-connect/node"); if (typeof portable.negotiateHttpConnect !== "function" || typeof node.connectHttpConnectStream !== "function" || typeof node.createNodeStreamCarrier !== "function") process.exit(1)'], { cwd: consumer, stdio: 'inherit' });
  const noise = packages.find(value => value.name === '@jokoagent/linkspan-noise');
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
    [noise.name]: overrides[noise.name]
  } }));
  execFileSync(packageManager.executable, [...packageManager.args, 'install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: consumer, stdio: 'inherit' });
  execFileSync(process.execPath, ['--input-type=module', '-e', 'const noise = await import("@jokoagent/linkspan-noise"); if (typeof noise.connectWebSocket !== "function" || typeof noise.connectStream !== "function") process.exit(1)'], { cwd: consumer, stdio: 'inherit' });
  const rtc = packages.find(value => value.name === '@jokoagent/linkspan-webrtc-node');
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
    [rtc.name]: overrides[rtc.name]
  } }));
  execFileSync(packageManager.executable, [...packageManager.args, 'install', '--offline', '--ignore-scripts', '--no-frozen-lockfile'], { cwd: consumer, stdio: 'inherit' });
  execFileSync(process.execPath, ['--input-type=module', '-e', 'const {createNodeWebRtcPeer}=await import("@jokoagent/linkspan-webrtc-node"); const peer=createNodeWebRtcPeer({iceServers:[]}); try { peer.createDataChannel("consumer-probe"); const offer=await peer.createOffer(); if (offer.type!=="offer" || !offer.sdp.includes("a=fingerprint:sha-256")) process.exitCode=1; } finally { await peer.close(); }'], { cwd: consumer, stdio: 'inherit' });
} finally { await rm(consumer, { recursive: true, force: true }); }
console.log(`Packed ${packages.length} independently consumable packages from ${sourceCommit} into ${destination}.`);

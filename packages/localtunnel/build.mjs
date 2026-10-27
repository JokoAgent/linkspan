import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = dirname(fileURLToPath(import.meta.url)), require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: directory, stdio: 'inherit' });
const patches = [];
const result = await build({ absWorkingDir: directory, entryPoints: [require.resolve('localtunnel')], outfile: 'dist/client.cjs',
  bundle: true, platform: 'node', format: 'cjs', target: 'node24', minify: true, sourcemap: true, metafile: true, legalComments: 'linked',
  plugins: [{ name: 'fixed-localtunnel-lifetime', setup(builder) {
    builder.onLoad({ filter: /[/\\]localtunnel[/\\]lib[/\\]Tunnel(?:Cluster)?\.js$/ }, async args => {
      const original = await readFile(args.path), inputSha256 = createHash('sha256').update(original).digest('hex');
      const cluster = args.path.endsWith('TunnelCluster.js');
      if (inputSha256 !== (cluster ? 'bddeb8e664e406fa5ce25fb24016d6d0032bd112c99680d3e1cb03abad4c49c1' : 'ec5f2172a2be75073fefb27b1ad7d11ca75b7aacdb0b1ec6b4b0440809089a80')) throw new Error('The fixed localtunnel lifetime input changed.');
      let source = original.toString('utf8');
      const replace = (before, after) => {
        if (source.split(before).length !== 2) throw new Error('The fixed localtunnel lifetime patch site changed.');
        source = source.replace(before, after);
      };
      if (cluster) {
        replace('this.opts = opts;', 'this.opts = opts; this.closed = false; this.sockets = new Set(); this.retries = new Set();');
        replace('  open() {', `  close() {
    if (this.closed) return;
    this.closed = true;
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
    for (const socket of this.sockets) socket.destroy();
  }

  open() {
    if (this.closed) return;`);
        replace('    remote.setKeepAlive(true);', `    this.sockets.add(remote);
    remote.once('close', () => this.sockets.delete(remote));
    remote.setKeepAlive(true);`);
        replace('    const connLocal = () => {', '    const connLocal = () => {\n      if (this.closed) { remote.destroy(); return; }');
        replace('      const remoteClose = () => {', `      this.sockets.add(local);
      local.once('close', () => this.sockets.delete(local));
      const remoteClose = () => {`);
        replace('        setTimeout(connLocal, 1000);', `        if (!this.closed) {
          const timer = setTimeout(() => { this.retries.delete(timer); connLocal(); }, 1000);
          this.retries.add(timer);
        }`);
      } else {
        replace('    this.closed = false;', '    this.closed = false; this.requestCancel = axios.CancelToken.source(); this.requestAgent = new (require("https").Agent)({ keepAlive: false });');
        replace("      responseType: 'json',", "      responseType: 'json', cancelToken: this.requestCancel.token, httpsAgent: this.requestAgent, timeout: 10000, maxContentLength: 16384, maxRedirects: 0, proxy: false,");
        replace('    const { id, ip, port, url, cached_url, max_conn_count } = body;', `    const { id, ip, port, url, cached_url, max_conn_count } = body;
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(max_conn_count || 1) || (max_conn_count || 1) < 1 || (max_conn_count || 1) > 32) throw new Error('Invalid bounded tunnel endpoint.');`);
        replace('          const body = res.data;', "          if (this.closed) return cb(new Error('The tunnel closed.'));\n          const body = res.data;");
        // Bind only the existing request loop to its owning Tunnel instance.
        replace('    (function getUrl() {', '    const owner = this;\n    (function getUrl() {');
        replace("          if (this.closed) return cb(new Error('The tunnel closed.'));", "          if (owner.closed) return cb(new Error('The tunnel closed.'));");
        replace('          return setTimeout(getUrl, 1000);', '          if (owner.closed) return cb(err);\n          owner.retryTimer = setTimeout(getUrl, 1000);');
        replace('  _establish(info) {', '  _establish(info) {\n    if (this.closed) return;');
        replace('    this.closed = true;', '    if (this.closed) return;\n    this.closed = true;\n    clearTimeout(this.retryTimer);\n    this.requestCancel.cancel();\n    this.requestAgent.destroy();\n    if (this.tunnelCluster) this.tunnelCluster.close();');
      }
      patches.push({ package: 'localtunnel', version: '2.0.2', file: `lib/${cluster ? 'TunnelCluster' : 'Tunnel'}.js`, inputSha256,
        outputSha256: createHash('sha256').update(source).digest('hex'), change: 'Cancel bootstrap requests/retry timers and destroy all owned connecting/live sockets on close; bound supplier connection counts.' });
      return { contents: source, loader: 'js', resolveDir: dirname(args.path) };
    });
  } }]
});
for (const output of Object.values(result.metafile.outputs)) for (const item of output.imports) if (!isBuiltin(item.path)) throw new Error(`Unexpected localtunnel runtime dependency: ${item.path}`);
const packages = new Map();
for (const file of Object.keys(result.metafile.inputs)) {
  if (!file.includes('node_modules')) continue;
  let candidate = dirname(resolve(directory, file));
  while (candidate !== dirname(candidate)) {
    try { const metadata = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8')); if (metadata.name) packages.set(`${metadata.name}@${metadata.version}`, { directory: candidate, metadata }); break; }
    catch { candidate = dirname(candidate); }
  }
}
const notices = ['Fixed third-party code in the independently selected Linkspan localtunnel adapter\n'], inventory = [];
for (const [identity, value] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const files = (await readdir(value.directory)).filter(name => /^(?:licen[sc]e|copying|notice)(?:$|[._-])/iu.test(name));
  if (!files.length) throw new Error(`Missing required license for ${identity}`);
  inventory.push({ name: value.metadata.name, version: value.metadata.version, license: value.metadata.license });
  notices.push(`\n${identity} (${value.metadata.license})\n`);
  for (const file of files.sort()) if ((await stat(join(value.directory, file))).isFile()) notices.push(`\n${file}\n${await readFile(join(value.directory, file), 'utf8')}\n`);
}
if (patches.length !== 2) throw new Error('Both fixed localtunnel lifetime patches are required.');
await writeFile(join(directory, 'dist/THIRD_PARTY_LICENSES.txt'), notices.join(''));
await writeFile(join(directory, 'dist/dependency-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
await writeFile(join(directory, 'dist/upstream-patches.json'), JSON.stringify(patches.sort((a, b) => a.file.localeCompare(b.file)), null, 2) + '\n');

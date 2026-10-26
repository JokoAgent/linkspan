import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const enginePatches = [];
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], { cwd: directory, stdio: 'inherit' });
// Keep the engine's ASN.1 decorators and schema registry in one fixed closure.
// Consumers can otherwise resolve two compatible-version WeakMap registries and
// fail certificate creation before a DTLS handshake even starts.
const result = await build({ absWorkingDir: directory, entryPoints: ['src/index.ts'], outfile: 'dist/index.js',
  bundle: true, platform: 'node', format: 'esm', target: 'node24', minify: true, sourcemap: true,
  metafile: true, legalComments: 'linked', external: ['@jokoagent/linkspan-core'],
  plugins: [{ name: 'fixed-bidirectional-stream-reset', setup(builder) {
    builder.onLoad({ filter: /[/\\]werift[/\\]lib[/\\]index\.mjs$/ }, async args => {
      const original = await readFile(args.path);
      const inputSha256 = createHash('sha256').update(original).digest('hex');
      if (original.length !== 726587 || inputSha256 !== '0848cdde8e5507cf9fe0de6e66e5bd1c4f7e5b0e8c0dae582fcdc29b9dcec62e') throw new Error('The fixed SCTP source input changed; revalidate the stream-reset patch.');
      let source = original.toString('utf8');
      for (const variable of ['p.streams', 'streamIds']) {
        const before = `this.onReconfigStreams.execute(${variable});`;
        if (source.split(before).length !== 2) throw new Error('The fixed SCTP reset completion site changed.');
        // A WebRTC data channel owns the same stream id in both directions.
        // The original implementation clears these maps on the corresponding
        // real reset/ACK, but emits completion for either half independently.
        // Keep the original wire handling and wait for both mature reset paths
        // before notifying RTCDataChannel.close / disposing its owning peer.
        source = source.replace(before, `this.onReconfigStreams.execute(${variable}.filter(streamId => !Object.hasOwn(this.inboundStreams, streamId) && !Object.hasOwn(this.outboundStreamSeq, streamId)));`);
      }
      const resetCondition = 'if (this.reconfigQueue.length > 0 && this.associationState === 4 /* ESTABLISHED */ && !this.reconfigRequest) {';
      if (source.split(resetCondition).length !== 2) throw new Error('The fixed SCTP outgoing reset state changed.');
      // A reset must not overtake DATA still queued or awaiting the original
      // SCTP acknowledgement. Wait only for the streams being reset, keeping
      // unrelated channels independent. Existing SACK processing resumes it.
      source = source.replace(resetCondition, 'if (this.reconfigQueue.length > 0 && this.associationState === 4 /* ESTABLISHED */ && !this.reconfigRequest && !this.outboundQueue.some(chunk => this.reconfigQueue.includes(chunk.streamId)) && !this.sentQueue.some(chunk => !chunk.acked && this.reconfigQueue.includes(chunk.streamId))) {');
      const sackProgress = 'await this.onSackReceived();\n    await this.transmit();';
      if (source.split(sackProgress).length !== 2) throw new Error('The fixed SCTP acknowledgement progress site changed.');
      source = source.replace(sackProgress, `${sackProgress}\n    await this.transmitReconfigRequest();`);
      enginePatches.push({ package: 'werift', version: '0.25.2', file: 'lib/index.mjs', inputBytes: original.length, inputSha256,
        outputSha256: createHash('sha256').update(source).digest('hex'), change: 'Wait for original SCTP DATA acknowledgement before resetting a stream, then emit RTC completion only after both directions reset.' });
      return { contents: source, loader: 'js', resolveDir: dirname(args.path) };
    });
  } }],
  banner: { js: 'import {createRequire as linkspanCreateRequire} from "node:module"; const require=linkspanCreateRequire(import.meta.url);' } });
const packages = new Map();
for (const [file, output] of Object.entries(result.metafile.outputs)) {
  for (const item of output.imports) if (!isBuiltin(item.path) && item.path !== '@jokoagent/linkspan-core') throw new Error(`Unexpected Node engine runtime import: ${item.path}`);
  if (/\.(?:node|wasm|exe)$/u.test(file)) throw new Error('The Node WebRTC engine must not carry another platform runtime.');
}
for (const file of Object.keys(result.metafile.inputs)) {
  if (!file.includes('node_modules')) continue;
  let candidate = dirname(resolve(directory, file));
  while (candidate !== dirname(candidate)) {
    try {
      const metadata = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'));
      if (metadata.name && !metadata.name.startsWith('@jokoagent/')) packages.set(`${metadata.name}@${metadata.version}`, { directory: candidate, metadata });
      break;
    } catch { candidate = dirname(candidate); }
  }
}
const notices = ['Third-party licenses included in the selected Linkspan Node WebRTC engine\n'];
const inventory = [];
for (const [identity, value] of [...packages].sort(([left], [right]) => left.localeCompare(right))) {
  const files = (await readdir(value.directory)).filter(name => /^(?:licen[sc]e|copying|notice)(?:$|[._-])/iu.test(name));
  inventory.push({ name: value.metadata.name, version: value.metadata.version, license: value.metadata.license });
  notices.push(`\n${identity} (${value.metadata.license})\n`);
  if (!files.length) {
    if (identity !== 'werift@0.25.2') throw new Error(`Missing required license for ${identity}`);
    notices.push(await readFile(join(directory, 'THIRD_PARTY_NOTICES.werift.txt'), 'utf8'));
  }
  for (const file of files.sort()) if ((await stat(join(value.directory, file))).isFile()) notices.push(`\n${file}\n${await readFile(join(value.directory, file), 'utf8')}\n`);
}
await writeFile(join(directory, 'dist/THIRD_PARTY_LICENSES.txt'), notices.join(''));
await writeFile(join(directory, 'dist/dependency-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
if (enginePatches.length !== 1) throw new Error('The fixed SCTP stream-reset patch was not included exactly once.');
await writeFile(join(directory, 'dist/upstream-patches.json'), JSON.stringify(enginePatches, null, 2) + '\n');
console.log(`Selected Node WebRTC engine: ${inventory.length} fixed bundled dependencies; no runtime package resolution or binary download.`);

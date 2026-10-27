import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, unlink, rmdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { x } from 'tar';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const manager = process.env.npm_execpath;
if (!manager) throw new Error('Run this builder through pnpm build:consumers.');
const executable = /\.[cm]?js$/i.test(manager) ? process.execPath : manager;
const prefix = executable === process.execPath ? [manager] : [];
const environment = { ...process.env, RUSTUP_TOOLCHAIN: '1.99.0', GOTOOLCHAIN: 'go1.27.3+auto' };
const command = async (file, args, cwd = root) => {
  const child = await execute(file, args, { cwd, env: environment, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  return child.stdout;
};
const pnpm = (args, cwd = root) => command(executable, [...prefix, ...args], cwd);
const destination = resolve(process.argv[2] ?? join(root, '.runtime', 'consumers'));
await mkdir(destination, { recursive: true });
if ((await readdir(destination)).length) throw new Error('Consumer output must be an empty build directory.');
const sourceCommit = (await command('git', ['rev-parse', 'HEAD'])).trim();
const sourceTree = (await command('git', ['rev-parse', 'HEAD^{tree}'])).trim();
if ((await command('git', ['status', '--porcelain', '--untracked-files=no'])).trim()) throw new Error('Build consumers from committed source.');
await pnpm(['build']);
await command('rustup', ['toolchain', 'install', '1.99.0', '--profile', 'minimal', '--target', 'wasm32-unknown-unknown']);
await pnpm(['build:browser-runtimes']);
const archiveDirectory = await mkdtemp(join(destination, '.pack-'));
const packages = [];
for (const module of (await readdir(join(root, 'packages'))).sort()) {
  const directory = join(root, 'packages', module);
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') continue; throw error; }
  if (!/^@jokoagent\/linkspan-[a-z-]+$/.test(manifest.name)) throw new Error('Unexpected consumer package.');
  await writeFile(join(directory, 'dist', 'source-build.json'), JSON.stringify({ sourceCommit, sourceTree, name: manifest.name }) + '\n');
  await pnpm(['pack', '--pack-destination', archiveDirectory], directory);
  const archive = join(archiveDirectory, `${manifest.name.slice(1).replace('/', '-')}-${manifest.version}.tgz`);
  const output = join(destination, module);
  await mkdir(output);
  await x({ file: archive, cwd: output, strip: 1, filter: (_path, entry) => ['File', 'Directory'].includes(entry.type) });
  await unlink(archive);
  const consumer = JSON.parse(await readFile(join(output, 'package.json'), 'utf8'));
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(consumer[section] ?? {})) if (name.startsWith('@jokoagent/linkspan-')) consumer[section][name] = '*';
  }
  await writeFile(join(output, 'package.json'), JSON.stringify(consumer, null, 2) + '\n');
  packages.push({ name: manifest.name, directory: module });
}
await rmdir(archiveDirectory);
await writeFile(join(destination, 'manifest.json'), JSON.stringify({ sourceRepository: 'https://github.com/JokoAgent/linkspan', sourceCommit, sourceTree, packages }, null, 2) + '\n');
console.log(`Prepared ${packages.length} source consumer directories without publishing.`);

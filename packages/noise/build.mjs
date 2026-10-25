import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFile, writeFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const directory = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], { cwd: directory, stdio: "inherit" });
const result = await build({
  absWorkingDir: directory,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  minify: true,
  sourcemap: true,
  metafile: true,
  legalComments: "linked",
  external: ["@jokoagent/linkspan-core"],
  define: { "Promise.withResolvers": "linkspanPromiseWithResolvers" },
  inject: ["src/promise-shim.ts"],
});
const inputs = Object.keys(result.metafile.inputs);
await writeFile(path.join(directory, "dist/build-meta.json"), `${JSON.stringify(result.metafile, null, 2)}\n`);
if (inputs.some((file) => /(?:\.wasm$|\/as-(?:sha256|chacha20poly1305)\/|crypto\/index\.js$)/.test(file) && file.includes("@chainsafe"))) {
  throw new Error("The portable Noise artifact included Node/AS WASM crypto");
}
if (Object.values(result.metafile.outputs).some((output) => output.imports.some((entry) => entry.path !== "@jokoagent/linkspan-core"))) {
  throw new Error("Unexpected external dependency in the portable Noise artifact");
}
const packages = new Map();
for (const input of inputs) {
  if (!input.includes("node_modules")) continue;
  let candidate = path.dirname(path.resolve(directory, input));
  while (candidate !== path.dirname(candidate)) {
    try {
      const metadata = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8"));
      if (metadata.name && !metadata.name.startsWith("@jokoagent/")) packages.set(`${metadata.name}@${metadata.version}`, { directory: candidate, metadata });
      break;
    } catch { candidate = path.dirname(candidate); }
  }
}
const notices = ["# Third-party licenses included in the Linkspan Noise artifact\n"];
const inventory = [];
const recoveredLicenseSources = JSON.parse(await readFile(path.join(directory, "licenses/sources.json"), "utf8"));
const recoveredMitLicense = await readFile(path.join(directory, "licenses/upstream-MIT.txt"), "utf8");
for (const [identity, value] of [...packages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const licenseFiles = (await readdir(value.directory)).filter((name) => /^(?:licen[sc]e|copying|notice)(?:$|[._-])/i.test(name));
  if (licenseFiles.length === 0 && !recoveredLicenseSources[identity]) throw new Error(`Missing license text for ${identity}`);
  inventory.push({ name: value.metadata.name, version: value.metadata.version, license: value.metadata.license });
  notices.push(`\n## ${identity} (${value.metadata.license})\n`);
  if (licenseFiles.length === 0) {
    notices.push(`\nMIT option selected. Published tarball omitted its license file.\nFixed official source: ${recoveredLicenseSources[identity]}\n\n${recoveredMitLicense}\n`);
  }
  for (const name of licenseFiles.sort()) {
    const filename = path.join(value.directory, name);
    if ((await stat(filename)).isFile()) notices.push(`\n### ${name}\n\n${await readFile(filename, "utf8")}\n`);
  }
}
await writeFile(path.join(directory, "dist/THIRD_PARTY_LICENSES.txt"), notices.join(""));
await writeFile(path.join(directory, "dist/dependency-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`);
for (const name of ["channel.d.ts", "identity.d.ts", "socket.d.ts", "promise-shim.d.ts"]) await unlink(path.join(directory, "dist", name));
console.log(`Portable Noise artifact: ${inventory.length} bundled packages; no supplier SDK, native binary, or WASM`);

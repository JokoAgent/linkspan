import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { prepareIrohNativeSource } from "./prepare-native-source.mjs";

const inputs = JSON.parse(await readFile(new URL("../upstream.json", import.meta.url), "utf8"));

/** Explicit build preparation. The thin npm package itself contains no native code. */
export async function prepareIrohRuntime({ directory, target = `${process.platform}-${process.arch}`, mode="native",wasmRuntimeDirectory,cacheDirectory,cargoExecutable, signal } = {}) {
  if (typeof directory !== "string" || !directory) throw new Error("An explicit native artifact directory is required.");
  if (target === "darwin-x64") {
    if(mode==="native")return prepareIrohNativeSource({directory,target,cacheDirectory,cargoExecutable,signal});
    if(mode!=="wasm")throw new Error("Select the explicit native or WASM runtime mode.");
    const source = wasmRuntimeDirectory ?? dirname(fileURLToPath(import.meta.resolve("@jokoagent/linkspan-iroh-wasm")));
    const destination = resolve(directory); await mkdir(destination,{recursive:true});
    const assets = ["index.js","runtime/linkspan_iroh.js","runtime/linkspan_iroh_bg.wasm","runtime/THIRD_PARTY_NOTICES.txt","runtime/rust-dependencies.json"];
    const files = {};
    for (const name of assets) {
      const bytes = await readFile(join(source,name));
      files[name] = createHash("sha256").update(bytes).digest("hex");
      await mkdir(dirname(join(destination,"wasm",name)),{recursive:true});
      await cp(join(source,name),join(destination,"wasm",name));
    }
    const receipt = { version:inputs.version,target,kind:"wasm",browserRelayOnly:true,files };
    await writeFile(join(destination,"iroh-runtime.json"),`${JSON.stringify(receipt,null,2)}\n`);
    return {filename:join(destination,"wasm","index.js"),receipt};
  }
  if(mode!=="native")throw new Error("The explicit WASM fallback is used only on the macOS Intel target; browser runtimes have their own independent package.");
  const selected = inputs.targets[target];
  if (!selected) throw new Error(`No prebuilt iroh runtime for ${target}; select the separately built WASM runtime or build the upstream N-API target.`);
  const url = `https://registry.npmjs.org/@number0/${selected.package}/-/${selected.package}-${inputs.version}.tgz`;
  const response = await fetch(url, { signal, redirect: "error" });
  if (!response.ok) throw new Error("The fixed iroh runtime archive could not be fetched.");
  const compressed = Buffer.from(await response.arrayBuffer());
  if (compressed.length > 32 * 1024 * 1024 || `sha512-${createHash("sha512").update(compressed).digest("base64")}` !== selected.integrity) throw new Error("The iroh archive integrity did not match the fixed input.");
  const archive = gunzipSync(compressed, { maxOutputLength: 128 * 1024 * 1024 });
  let native;
  let metadata;
  for (let offset = 0; offset + 512 <= archive.length;) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every(value => value === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").split("\0")[0];
    const size = parseInt(header.subarray(124, 136).toString("ascii").replace(/\0.*$/u, "").trim(), 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > archive.length) throw new Error("Malformed fixed iroh archive.");
    const type = header[156];
    if ((type === 0 || type === 48) && name === "package/package.json") metadata = JSON.parse(archive.subarray(offset + 512, offset + 512 + size).toString("utf8"));
    if ((type === 0 || type === 48) && /^package\/iroh\.[A-Za-z0-9_.-]+\.node$/u.test(name)) {
      if (native) throw new Error("Unexpected duplicate native iroh artifact.");
      native = archive.subarray(offset + 512, offset + 512 + size);
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!native || metadata?.name !== `@number0/${selected.package}` || metadata.version !== inputs.version) throw new Error("The fixed iroh archive did not contain its expected native module.");
  const destination = resolve(directory);
  await mkdir(destination, { recursive: true });
  const filename = join(destination, "iroh.node");
  await writeFile(filename, native);
  await cp(new URL("../THIRD_PARTY_NOTICES.txt",import.meta.url),join(destination,"THIRD_PARTY_NOTICES.txt"));
  await cp(new URL("../rust-dependencies.json",import.meta.url),join(destination,"rust-dependencies.json"));
  const receipt = { version: inputs.version, sourceCommit: inputs.sourceCommit, target, upstreamIntegrity: selected.integrity, bytes: native.length, sha256: createHash("sha256").update(native).digest("hex") };
  await writeFile(join(destination, "iroh-runtime.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  return { filename, receipt };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await prepareIrohRuntime({ directory: process.argv[2], target: process.argv[3] });
  console.log(JSON.stringify(result.receipt));
}

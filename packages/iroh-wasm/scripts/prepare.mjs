import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { rustBuildEnvironment } from "./environment.mjs";
export { rustBuildEnvironment } from "./environment.mjs";
import { prepareIrohWasmToolchain } from "./toolchains.mjs";
import { collectRustNotices } from "./notices.mjs";
export { collectRustNotices } from "./notices.mjs";
export { prepareIrohWasmToolchain } from "./toolchains.mjs";
const exec = promisify(execFile);
export async function prepareIrohWasm({ directory = fileURLToPath(new URL("../dist/runtime", import.meta.url)), cargoExecutable = process.env.LINKSPAN_CARGO_EXECUTABLE ?? "cargo", wasmBindgenExecutable = process.env.LINKSPAN_WASM_BINDGEN_EXECUTABLE, clangExecutable = process.env.LINKSPAN_WASM_CLANG_EXECUTABLE, toolchainDirectory = process.env.LINKSPAN_SDK_TOOLCHAIN_DIR ?? join(tmpdir(),"linkspan-sdk-toolchains"), signal } = {}) {
  const source = fileURLToPath(new URL("../rust", import.meta.url));
  const sources={};for(const name of ["Cargo.toml","Cargo.lock","src/lib.rs"])sources[name]=createHash("sha256").update(await readFile(join(source,name))).digest("hex");
  let toolInputs;
  if (!wasmBindgenExecutable || !clangExecutable) {
    const prepared = await prepareIrohWasmToolchain({directory:toolchainDirectory,signal});
    wasmBindgenExecutable ??= prepared.wasmBindgenExecutable;
    clangExecutable ??= prepared.clangExecutable;
    toolInputs = prepared.inputs;
  }
  const { stdout: version } = await exec(cargoExecutable,["--version"],{signal});
  const environment=rustBuildEnvironment({cargoExecutable,clangExecutable});
  const {stdout:rustVersion}=await exec(environment.RUSTC,["--version"],{signal});
  const { stdout: bindingVersion } = await exec(wasmBindgenExecutable,["--version"],{signal});
  if (!/^cargo 1\.99\.0 /u.test(version) || !/^rustc 1\.99\.0 /u.test(rustVersion) || bindingVersion.trim() !== "wasm-bindgen 0.2.112") throw new Error("Fixed Rust/Cargo 1.99.0 and wasm-bindgen 0.2.112 are required.");
  await exec(cargoExecutable,["build","--locked","--release","--target","wasm32-unknown-unknown"],{cwd:source,signal,maxBuffer:16*1024*1024,env:environment});
  const destination = resolve(directory); await mkdir(destination,{recursive:true});
  const target = process.env.CARGO_TARGET_DIR ?? join(source,"target");
  await exec(wasmBindgenExecutable,[join(target,"wasm32-unknown-unknown","release","linkspan_iroh.wasm"),"--target","web","--out-dir",destination,"--out-name","linkspan_iroh"],{signal});
  const dependencies = await collectRustNotices({cargoExecutable,manifest:join(source,"Cargo.toml"),rootPackage:"linkspan_iroh",directory:destination,filterPlatform:"wasm32-unknown-unknown",signal});
  const bytes = await readFile(join(destination,"linkspan_iroh_bg.wasm"));
  for(const[name,expected]of Object.entries(sources))if(createHash("sha256").update(await readFile(join(source,name))).digest("hex")!==expected)throw new Error("The Rust source changed while its artifact was being prepared.");
  const receipt = { coreVersion:"1.4.1",wasmBindgen:"0.2.112",target:"browser-wasm",bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),cargoLockSha256:sources["Cargo.lock"],sources,toolInputs,dependencyCount:dependencies.length };
  await writeFile(join(destination,"iroh-wasm.json"),`${JSON.stringify(receipt,null,2)}\n`); return receipt;
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify(await prepareIrohWasm()));

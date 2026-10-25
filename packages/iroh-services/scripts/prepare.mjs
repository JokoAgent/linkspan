import { prepareIrohWasmToolchain,collectRustNotices,rustBuildEnvironment } from "@jokoagent/linkspan-iroh-wasm/prepare";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir,readFile,writeFile } from "node:fs/promises";
import { join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
const exec=promisify(execFile);
export async function prepareIrohServices({directory=fileURLToPath(new URL("../dist/runtime",import.meta.url)),cargoExecutable=process.env.LINKSPAN_CARGO_EXECUTABLE??"cargo",wasmBindgenExecutable=process.env.LINKSPAN_WASM_BINDGEN_EXECUTABLE,clangExecutable=process.env.LINKSPAN_WASM_CLANG_EXECUTABLE,toolchainDirectory=process.env.LINKSPAN_SDK_TOOLCHAIN_DIR??join(tmpdir(),"linkspan-sdk-toolchains"),signal}={}) {
  if(!wasmBindgenExecutable||!clangExecutable){const tools=await prepareIrohWasmToolchain({directory:toolchainDirectory,signal});wasmBindgenExecutable??=tools.wasmBindgenExecutable;clangExecutable??=tools.clangExecutable;}
  const {stdout:version}=await exec(cargoExecutable,["--version"],{signal});const{stdout:bindgen}=await exec(wasmBindgenExecutable,["--version"],{signal});
  if(!/^cargo 1\.99\.0 /u.test(version)||bindgen.trim()!=="wasm-bindgen 0.2.112")throw new Error("Fixed Cargo1.99.0 and wasm-bindgen0.2.112 are required.");
  const source=fileURLToPath(new URL("../rust",import.meta.url));
  const sources={};for(const name of ["Cargo.toml","Cargo.lock","src/lib.rs"])sources[name]=createHash("sha256").update(await readFile(join(source,name))).digest("hex");
  const environment=rustBuildEnvironment({cargoExecutable,clangExecutable});const{stdout:rustVersion}=await exec(environment.RUSTC,["--version"],{signal});if(!/^rustc 1\.99\.0 /u.test(rustVersion))throw new Error("Fixed Rust1.99.0 is required.");
  await exec(cargoExecutable,["build","--locked","--release","--target","wasm32-unknown-unknown"],{cwd:source,signal,maxBuffer:16*1024*1024,env:environment});
  const output=resolve(directory);await mkdir(output,{recursive:true});
  const target=process.env.CARGO_TARGET_DIR??join(source,"target");
  await exec(wasmBindgenExecutable,[join(target,"wasm32-unknown-unknown","release","linkspan_iroh_services.wasm"),"--target","web","--out-dir",output,"--out-name","linkspan_iroh_services"],{signal});
  await collectRustNotices({cargoExecutable,manifest:join(source,"Cargo.toml"),rootPackage:"linkspan_iroh_services",directory:output,filterPlatform:"wasm32-unknown-unknown",signal});
  const bytes=await readFile(join(output,"linkspan_iroh_services_bg.wasm"));
  for(const[name,expected]of Object.entries(sources))if(createHash("sha256").update(await readFile(join(source,name))).digest("hex")!==expected)throw new Error("The Rust source changed while its artifact was being prepared.");
  const receipt={upstream:"iroh-services@1.0.0",target:"portable-wasm",bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),cargoLockSha256:sources["Cargo.lock"],sources};
  await writeFile(join(output,"iroh-services.json"),JSON.stringify(receipt,null,2)+"\n");return receipt;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await prepareIrohServices()));

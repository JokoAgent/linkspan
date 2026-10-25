import { createHash,randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { release } from "node:os";
const exec = promisify(execFile);
const targets = {
  "win32-x64": { wasi:"x86_64-windows", wasiBytes:619003408,wasiHash:"cccb5c323a9b34f0349a9b09e8804a0a7632c68c3310f4b5f437ed57d7e71d8f", bindgen:"x86_64-pc-windows-msvc",bindgenBytes:7324668, bindgenHash:"3d27006649aee52631d76cb6767e32a974b1c85f9b46140a9695bea38a33bbac" },
  "win32-arm64": { wasi:"arm64-windows",wasiBytes:620307231,wasiHash:"45e1c71f3e965621e7b98ebe1d37b0e4b1f77f3e8072113ffb4534e67b1a4b7c",bindgen:"x86_64-pc-windows-msvc",bindgenBytes:7324668,bindgenHash:"3d27006649aee52631d76cb6767e32a974b1c85f9b46140a9695bea38a33bbac",bindgenWindowsX64Emulation:true },
  "darwin-arm64": { wasi:"arm64-macos",wasiBytes:180322002, wasiHash:"9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9", bindgen:"aarch64-apple-darwin",bindgenBytes:7790287, bindgenHash:"fdfb85d075753d55cd4a13c7b8217aab5e0ea4de30c619778571b8d7ec985882" },
  "darwin-x64": { wasi:"x86_64-macos",wasiBytes:182668326, wasiHash:"87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb", bindgen:"x86_64-apple-darwin",bindgenBytes:8248674, bindgenHash:"f530fd511caf61d0f7cc92586b1491b2d74dc1d60d6bb065e37ca88e21edae5d" },
  "linux-x64": { wasi:"x86_64-linux",wasiBytes:192383077, wasiHash:"b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4", bindgen:"x86_64-unknown-linux-musl",bindgenBytes:11200723, bindgenHash:"811a3f5f1c776bc6322ec41e38765e08bd0639a405e7c71a823012e676f3381e" },
  "linux-arm64": { wasi:"arm64-linux",wasiBytes:192255247, wasiHash:"f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971", bindgen:"aarch64-unknown-linux-gnu",bindgenBytes:11040481, bindgenHash:"361cc134331ffa65ffcc7492a44e5b29e77cfa5a1f05d52833af463dd8019e0a" }
};

/** Bound the streamed download to this exact official archive, including cache hits. */
export async function downloadFixedArchive(url, sha256, expectedBytes, directory, signal) {
  const name=new URL(url).pathname.split("/").at(-1);
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(name??"")||!Number.isSafeInteger(expectedBytes)||expectedBytes<1||!/^[a-f0-9]{64}$/u.test(sha256))throw new Error("Invalid fixed build tool input.");
  const filename=join(resolve(directory),name);
  try {
    const hash=createHash("sha256");let count=0;
    for await(const chunk of createReadStream(filename)){signal?.throwIfAborted();count+=chunk.length;if(count>expectedBytes)break;hash.update(chunk);}
    if(count===expectedBytes&&hash.digest("hex")===sha256)return filename;
  }catch(error){if(signal?.aborted)throw error;}
  const response=await fetch(url,{signal});
  if(!response.ok||!response.body)throw new Error("The fixed WASM build tool could not be fetched.");
  const length=response.headers.get("content-length");
  if(length!==null&&Number(length)!==expectedBytes){await response.body.cancel();throw new Error("The fixed WASM build tool archive size did not match its official input.");}
  const temporary=`${filename}.${randomUUID()}.partial`;let output;
  try{
    output=await open(temporary,"wx");const hash=createHash("sha256");let count=0;
    for await(const chunk of response.body){signal?.throwIfAborted();count+=chunk.byteLength;if(count>expectedBytes)throw new Error("The fixed WASM build tool exceeded its official archive size.");hash.update(chunk);await output.writeFile(chunk);}
    if(count!==expectedBytes||hash.digest("hex")!==sha256)throw new Error("The fixed WASM build tool failed integrity verification.");
    await output.close();output=undefined;await rename(temporary,filename);return filename;
  }finally{
    await output?.close();await rm(temporary,{force:true});
  }
}
async function unpack(url, sha256, bytes, directory, signal) {
  const filename=await downloadFixedArchive(url,sha256,bytes,directory,signal);
  await exec("tar",["-xf",filename,"-C",directory],{signal,maxBuffer:2*1024*1024});
}

/** Explicit preparation of build tools, never a client/runtime code path. */
export async function prepareIrohWasmToolchain({ directory, target = `${process.platform}-${process.arch}`, signal }) {
  const input = targets[target]; if (!input) throw new Error("This WASM builder platform needs an explicitly supplied compiler and wasm-bindgen.");
  if(input.bindgenWindowsX64Emulation&&process.platform==="win32"&&Number(release().split(".")[2])<22000)throw new Error("The fixed wasm-bindgen host tool requires Windows11 x64 application emulation on ARM64; the selected SDK/WASM target is unchanged.");
  const destination = resolve(directory); await mkdir(destination,{recursive:true});
  await unpack(`https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-34/wasi-sdk-34.0-${input.wasi}.tar.gz`,input.wasiHash,input.wasiBytes,destination,signal);
  await unpack(`https://github.com/wasm-bindgen/wasm-bindgen/releases/download/0.2.112/wasm-bindgen-0.2.112-${input.bindgen}.tar.gz`,input.bindgenHash,input.bindgenBytes,destination,signal);
  const suffix = target.startsWith("win32-") ? ".exe" : "";
  return { clangExecutable:join(destination,`wasi-sdk-34.0-${input.wasi}`,"bin",`clang${suffix}`), wasmBindgenExecutable:join(destination,`wasm-bindgen-0.2.112-${input.bindgen}`,`wasm-bindgen${suffix}`), inputs: { hostTarget:target,wasiSdk:"34.0",wasiArchiveSha256:input.wasiHash,wasiArchiveBytes:input.wasiBytes,wasmBindgen:"0.2.112",bindgenArchiveSha256:input.bindgenHash,bindgenArchiveBytes:input.bindgenBytes,...(input.bindgenWindowsX64Emulation?{wasmBindgenHost:"x86_64-pc-windows-msvc",requiresWindows11X64Emulation:true}:{}) } };
}

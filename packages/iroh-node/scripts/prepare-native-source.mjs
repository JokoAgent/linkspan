import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { cp,mkdir,mkdtemp,readFile,writeFile } from "node:fs/promises";
import { dirname,join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { downloadMobileInput } from "./mobile-files.mjs";
const exec=promisify(execFile);
const inputs=JSON.parse(await readFile(new URL("../mobile-inputs.json",import.meta.url),"utf8"));

/** Build the exact official N-API binding when no published target binary exists. */
export async function prepareIrohNativeSource({directory,target="darwin-x64",cacheDirectory=join(tmpdir(),"linkspan-iroh-native-source"),cargoExecutable=process.env.LINKSPAN_CARGO_EXECUTABLE??"cargo",signal}={}){
  if(process.platform!=="darwin"||target!=="darwin-x64"||typeof directory!=="string"||!directory)throw new Error("The fixed macOS Intel native SDK source build requires macOS, an explicit artifact directory and the darwin-x64 target.");
  const destination=resolve(directory),cache=resolve(cacheDirectory);await mkdir(destination,{recursive:true});await mkdir(cache,{recursive:true});
  const archive=await downloadMobileInput(inputs.source,cache,signal),source=await mkdtemp(join(cache,"source-"));
  await exec("tar",["-xzf",archive,"-C",source,"--strip-components=1"],{signal});
  const rustc=cargoExecutable.includes("/")?join(dirname(cargoExecutable),"rustc"):"rustc";
  const[{stdout:cargoVersion},{stdout:rustVersion},{stdout:sdk},{stdout:compiler},{stdout:xcode}]=await Promise.all([
    exec(cargoExecutable,["--version"],{signal}),exec(rustc,["--version"],{signal}),exec("xcrun",["--sdk","macosx","--show-sdk-path"],{signal}),exec("xcrun",["--sdk","macosx","--find","clang"],{signal}),exec("xcodebuild",["-version"],{signal})
  ]);
  if(!/^cargo 1\.99\.0 /u.test(cargoVersion)||!/^rustc 1\.99\.0 /u.test(rustVersion))throw new Error("The fixed macOS native SDK source build requires Rust/Cargo1.99.0.");
  const environment={...process.env};for(const key of Object.keys(environment))if(/^(?:RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_PROFILE_RELEASE_|CARGO_TARGET_.*_(?:RUSTFLAGS|LINKER)$|CFLAGS|CXXFLAGS|CC(?:_|$)|CXX(?:_|$)|AR(?:_|$))/u.test(key))delete environment[key];
  const targetDirectory=join(cache,`rust-${inputs.sourceCommit}`);
  Object.assign(environment,{RUSTC:rustc,RUSTC_WRAPPER:"",RUSTC_WORKSPACE_WRAPPER:"",CARGO_TARGET_DIR:targetDirectory,CARGO_INCREMENTAL:"0",MACOSX_DEPLOYMENT_TARGET:"10.13",SDKROOT:sdk.trim(),CC_x86_64_apple_darwin:compiler.trim(),CARGO_TARGET_X86_64_APPLE_DARWIN_LINKER:compiler.trim(),CARGO_ENCODED_RUSTFLAGS:[`--remap-path-prefix=${source}=/build`,`--remap-path-prefix=${cache}=/cache`,"-Cdebuginfo=0"].join("\x1f")});
  await exec(cargoExecutable,["build","--locked","--release","--lib","-p","number0_iroh","--target","x86_64-apple-darwin"],{cwd:source,env:environment,signal,maxBuffer:16*1024*1024});
  const bytes=await readFile(join(targetDirectory,"x86_64-apple-darwin/release/libnumber0_iroh.dylib"));
  const filename=join(destination,"iroh.node");await writeFile(filename,bytes);
  await cp(new URL("../THIRD_PARTY_NOTICES.txt",import.meta.url),join(destination,"THIRD_PARTY_NOTICES.txt"));
  await cp(new URL("../rust-dependencies.json",import.meta.url),join(destination,"rust-dependencies.json"));
  const receipt={version:"1.2.0",kind:"native-source",target,sourceCommit:inputs.sourceCommit,sourceArchiveSha256:inputs.source.sha256,cargoLockSha256:createHash("sha256").update(await readFile(join(source,"Cargo.lock"))).digest("hex"),rust:"1.99.0",macosDeploymentTarget:"10.13",xcode:xcode.trim(),sourceUnmodified:true,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
  await writeFile(join(destination,"iroh-runtime.json"),JSON.stringify(receipt,null,2)+"\n");return{filename,receipt};
}

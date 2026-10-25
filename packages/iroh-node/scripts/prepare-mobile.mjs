import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { cp,lstat,mkdir,mkdtemp,readFile,readdir,writeFile } from "node:fs/promises";
import { dirname,join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { downloadMobileInput,readMobileZip,createMobileJar,verifyAndroidLibrary } from "./mobile-files.mjs";

const exec=promisify(execFile);
const inputs=JSON.parse(await readFile(new URL("../mobile-inputs.json",import.meta.url),"utf8"));
const androidAbis=["arm64-v8a","armeabi-v7a","x86_64","x86"];
const appleTargets={"ios-arm64":{rust:"aarch64-apple-ios",sdk:"iphoneos",kind:"device"},"ios-simulator-arm64":{rust:"aarch64-apple-ios-sim",sdk:"iphonesimulator",kind:"simulator"},"ios-simulator-x64":{rust:"x86_64-apple-ios",sdk:"iphonesimulator",kind:"simulator"}};
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");

/** Explicit target preparation. No application startup path downloads code. */
export async function prepareIrohMobileRuntime({directory,platform,targets,cacheDirectory=join(tmpdir(),"linkspan-iroh-mobile-inputs"),cargoExecutable=process.env.LINKSPAN_CARGO_EXECUTABLE??"cargo",signal}={}){
  if(typeof directory!=="string"||!directory||!["ios","android"].includes(platform)||!Array.isArray(targets)||targets.length===0||new Set(targets).size!==targets.length)throw new Error("Select an explicit mobile platform, target list, and artifact directory.");
  const destination=resolve(directory),cache=resolve(cacheDirectory);await mkdir(destination,{recursive:true});await mkdir(cache,{recursive:true});
  const preparer={scriptSha256:digest(await readFile(fileURLToPath(import.meta.url))),archiveHelpersSha256:digest(await readFile(new URL("./mobile-files.mjs",import.meta.url)))};
  if((await readdir(destination)).length!==0){
    let previous;try{previous=JSON.parse(await readFile(join(destination,"native-runtime.json"),"utf8"));}catch{}
    if(previous?.upstream!==inputs.upstream||previous.sourceCommit!==inputs.sourceCommit||previous.platform!==platform||JSON.stringify(previous.targets)!==JSON.stringify(targets)||JSON.stringify(previous.preparer)!==JSON.stringify(preparer)||!previous.files)throw new Error("Use a fresh build-owned native output directory for changed SDK inputs or target selections.");
    const expected=new Set(["native-runtime.json",...Object.keys(previous.files)]);const actual=[];
    async function verify(path,prefix=""){for(const name of await readdir(path)){const relative=prefix?`${prefix}/${name}`:name;const filename=join(path,name),info=await lstat(filename);if(info.isSymbolicLink())throw new Error("A native build output cannot contain links.");if(info.isDirectory())await verify(filename,relative);else{if(!info.isFile()||!expected.has(relative)||relative!=="native-runtime.json"&&digest(await readFile(filename))!==previous.files[relative])throw new Error("An existing native build output changed; choose a fresh build-owned directory.");actual.push(relative);}}}
    await verify(destination);if(actual.length!==expected.size)throw new Error("An existing native build output is incomplete; choose a fresh build-owned directory.");
    const required=platform==="android"?[...Object.values(inputs.android),...inputs.notices]:[inputs.source,inputs.iosHeaders];
    for(const input of required)if(previous.inputs?.[input.url]?.sha256!==input.sha256||previous.inputs[input.url].bytes!==input.bytes)throw new Error("An existing native build output has different fixed upstream inputs.");
    return{directory:destination,receipt:previous};
  }
  const builtInputs={};const files={};
  async function load(input){const filename=await downloadMobileInput(input,cache,signal);builtInputs[input.url]={bytes:input.bytes,sha256:input.sha256};return readFile(filename);}
  async function save(name,bytes){const filename=join(destination,name);await mkdir(dirname(filename),{recursive:true});await writeFile(filename,bytes);files[name]=digest(bytes);}
  if(platform==="android"){
    if(targets.some(target=>!androidAbis.includes(target)))throw new Error("Select supported Android ABI targets explicitly.");
    const [aar,jar,jna]=await Promise.all([load(inputs.android.irohAar),load(inputs.android.irohJar),load(inputs.android.jnaAar)]);
    const selected=new Set(targets);
    const iroh=readMobileZip(aar,name=>name==="classes.jar"||/^jni\//u.test(name)&&selected.has(name.split("/")[1]));
    const access=readMobileZip(jna,name=>name==="classes.jar"||/^jni\//u.test(name)&&selected.has(name.split("/")[1]));
    const api=readMobileZip(jar,name=>!/^\/(?:darwin|linux|win32)/u.test(`/${name}`)&&!/(?:\.dll|\.dylib|\.so)$/u.test(name)&&!/^META-INF\/MANIFEST.MF$/u.test(name));
    for(const[name,bytes]of readMobileZip(iroh.get("classes.jar")??Buffer.alloc(0),name=>name!=="META-INF/MANIFEST.MF")){
      if(api.has(name)&&!api.get(name).equals(bytes))throw new Error("The fixed Android API classes collide.");api.set(name,bytes);
    }
    await save("android/libs/iroh-api.jar",createMobileJar(api));
    const accessApi=readMobileZip(access.get("classes.jar")??Buffer.alloc(0),name=>!/(?:\.dll|\.dylib|\.so)$/u.test(name));
    await save("android/libs/jna-api.jar",createMobileJar(accessApi));
    for(const abi of targets){
      for(const[name,source]of [["libiroh_ffi.so",iroh],["libjnidispatch.so",access]]){
        const bytes=source.get(`jni/${abi}/${name}`);if(!bytes)throw new Error("The fixed SDK did not contain the selected Android ABI.");verifyAndroidLibrary(bytes,abi);if(name==="libiroh_ffi.so"&&!bytes.includes(Buffer.from("Java_computer_iroh_IrohAndroid_installAndroidContext")))throw new Error("The fixed SDK library is missing its Android initialization entry.");await save(`android/jniLibs/${abi}/${name}`,bytes);
      }
    }
  }else{
    if(process.platform!=="darwin")throw new Error("Apple native SDK compilation requires macOS and Xcode; no foreign binary is substituted.");
    if(targets.some(target=>!appleTargets[target]))throw new Error("Select supported iOS device/simulator targets explicitly.");
    const {stdout:cargoVersion}=await exec(cargoExecutable,["--version"],{signal});
    const rustc=cargoExecutable.includes("/")?join(dirname(cargoExecutable),"rustc"):"rustc";
    const {stdout:rustVersion}=await exec(rustc,["--version"],{signal});
    if(!/^cargo 1\.99\.0 /u.test(cargoVersion)||!/^rustc 1\.99\.0 /u.test(rustVersion))throw new Error("The native SDK source build requires fixed Rust/Cargo1.99.0.");
    const archive=await downloadMobileInput(inputs.source,cache,signal);builtInputs[inputs.source.url]={bytes:inputs.source.bytes,sha256:inputs.source.sha256};
    const source=await mkdtemp(join(cache,"source-"));await exec("tar",["-xzf",archive,"-C",source,"--strip-components=1"],{signal});
    const headers=readMobileZip(await load(inputs.iosHeaders),name=>name.startsWith("Iroh.xcframework/ios-arm64/Headers/"));
    const include=join(source,"linkspan-headers");await mkdir(include);
    for(const name of ["iroh_ffiFFI.h","Export.h","module.modulemap"]){const bytes=headers.get(`Iroh.xcframework/ios-arm64/Headers/${name}`);if(!bytes)throw new Error("The fixed Apple FFI header input is missing.");await writeFile(join(include,name),bytes);}
    const targetDirectory=join(cache,`rust-${inputs.sourceCommit}`);const libraries=[];
    for(const target of targets){
      const selected=appleTargets[target];const {stdout:sdk}=await exec("xcrun",["--sdk",selected.sdk,"--show-sdk-path"],{signal});const{stdout:compiler}=await exec("xcrun",["--sdk",selected.sdk,"--find","clang"],{signal});
      const environment={...process.env};for(const key of Object.keys(environment))if(/^(?:RUSTFLAGS|CARGO_BUILD_RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|CARGO_PROFILE_RELEASE_|CARGO_TARGET_.*_(?:RUSTFLAGS|LINKER)$|CFLAGS|CXXFLAGS|CC(?:_|$)|CXX(?:_|$)|AR(?:_|$))/u.test(key))delete environment[key];
      const field=selected.rust.replaceAll("-","_");const upper=field.toUpperCase();
      Object.assign(environment,{RUSTC:rustc,RUSTC_WRAPPER:"",RUSTC_WORKSPACE_WRAPPER:"",CARGO_TARGET_DIR:targetDirectory,CARGO_INCREMENTAL:"0",IPHONEOS_DEPLOYMENT_TARGET:"16.4",SDKROOT:sdk.trim(),CARGO_ENCODED_RUSTFLAGS:[`--remap-path-prefix=${source}=/build`,`--remap-path-prefix=${cache}=/cache`,"-Cdebuginfo=0"].join("\x1f"),[`CC_${field}`]:compiler.trim(),[`CARGO_TARGET_${upper}_LINKER`]:compiler.trim()});
      await exec(cargoExecutable,["build","--locked","--release","--lib","-p","iroh-ffi","--target",selected.rust],{cwd:source,env:environment,signal,maxBuffer:16*1024*1024});
      libraries.push({kind:selected.kind,target,filename:join(targetDirectory,selected.rust,"release/libiroh_ffi.a")});
    }
    const arguments_=["-create-xcframework"];
    for(const kind of ["device","simulator"]){
      const group=libraries.filter(value=>value.kind===kind);if(group.length===0)continue;let filename=group[0].filename;
      if(group.length>1){filename=join(source,`libiroh_ffi-${kind}.a`);await exec("xcrun",["lipo","-create",...group.map(value=>value.filename),"-output",filename],{signal});}
      arguments_.push("-library",filename,"-headers",include);
    }
    const xcframework=join(source,"Iroh.xcframework");arguments_.push("-output",xcframework);await exec("xcodebuild",arguments_,{signal,maxBuffer:4*1024*1024});
    await cp(xcframework,join(destination,"ios/Iroh.xcframework"),{recursive:true});
    const binding=await readFile(join(source,"IrohLib/Sources/IrohLib/IrohLib.swift"));await save("ios/IrohLib.swift",binding);
    async function record(path,prefix){for(const name of await readdir(path,{withFileTypes:true})){if(name.isSymbolicLink())throw new Error("Unexpected symbolic link in the built native SDK.");if(name.isDirectory())await record(join(path,name.name),`${prefix}/${name.name}`);else files[`${prefix}/${name.name}`]=digest(await readFile(join(path,name.name)));}}
    await record(join(destination,"ios/Iroh.xcframework"),"ios/Iroh.xcframework");
    await save("ios/build-inputs/Cargo.lock",await readFile(join(source,"Cargo.lock")));
    await save("ios/build-inputs/Cargo.toml",await readFile(join(source,"Cargo.toml")));
  }
  let notices=await readFile(new URL("../THIRD_PARTY_NOTICES.txt",import.meta.url),"utf8");
  if(platform==="android")for(const input of inputs.notices)notices+=`\n\n=== ${input.name} ===\nFixed source: ${input.url}\n${(await load(input)).toString("utf8")}`;
  await save("THIRD_PARTY_NOTICES.txt",Buffer.from(notices));
  await save("rust-dependencies.json",await readFile(new URL("../rust-dependencies.json",import.meta.url)));
  const receipt={upstream:inputs.upstream,sourceCommit:inputs.sourceCommit,platform,targets:[...targets],preparer,...(platform==="ios"?{rust:"1.99.0",iosDeploymentTarget:"16.4",sdkSourceUnmodified:true}:{jnaVersion:inputs.androidJna.version,android64BitLoadSegmentAlignment:16384}),inputs:builtInputs,files};
  await writeFile(join(destination,"native-runtime.json"),JSON.stringify(receipt,null,2)+"\n");return{directory:destination,receipt};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify((await prepareIrohMobileRuntime({directory:process.argv[2],platform:process.argv[3],targets:process.argv[4]?.split(",")})).receipt));

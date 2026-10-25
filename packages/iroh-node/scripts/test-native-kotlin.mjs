import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir,mkdtemp,readFile,writeFile } from "node:fs/promises";
import { delimiter,dirname,join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { downloadMobileInput,readMobileZip,verifyAndroidLibrary } from "./mobile-files.mjs";
import { prepareIrohMobileRuntime } from "./prepare-mobile.mjs";
const exec=promisify(execFile);
const compilerInput={url:"https://github.com/JetBrains/kotlin/releases/download/v2.2.21/kotlin-compiler-2.2.21.zip",bytes:78710880,sha256:"a623871f1cd9c938946948b70ef9170879f0758043885bbd30c32f024e511714"};
const validationInputs=[
  {url:"https://repo.maven.apache.org/maven2/net/java/dev/jna/jna/5.19.1/jna-5.19.1.jar",bytes:1950853,sha256:"4fb141dd8ef6b0585ffceea4bc49602fbc6312fa977e2c488794ea3e6aafecae"},
  {url:"https://repo.maven.apache.org/maven2/org/jetbrains/kotlinx/kotlinx-coroutines-core-jvm/1.9.0/kotlinx-coroutines-core-jvm-1.9.0.jar",bytes:1463587,sha256:"ad89c2892235e670f222d819cb3d81188143cb19a05b59df9889ae4269f5c70a"},
  {url:"https://repo.maven.apache.org/maven2/org/json/json/20250517/json-20250517.jar",bytes:82710,sha256:"3ea61b2a06e31edf1c91134fe9106b0ebb16628be169f3db75bc7a2b06b45796"}
];

/** An explicit build check against the real official SDK, never a fake carrier. */
export async function testNativeIrohKotlin({directory=join(tmpdir(),"linkspan-iroh-kotlin-validation"),sourceDirectory,javaExecutable=process.env.LINKSPAN_JAVA_EXECUTABLE??"java",signal}={}){
  if(process.platform==="darwin"&&process.arch==="x64")throw new Error("The official JVM archive has no macOS Intel native library; run this native UDP check on Linux x64/arm64, Windows x64, or macOS arm64.");
  const root=resolve(directory);await mkdir(root,{recursive:true});
  if(sourceDirectory===undefined){
    try{sourceDirectory=dirname(createRequire(join(process.cwd(),"package.json")).resolve("@jokoagent/linkspan-iroh/native-sources"));}
    catch{
      const candidate=fileURLToPath(new URL("../../iroh/native",import.meta.url));
      try{if(JSON.parse(await readFile(join(candidate,"sources.json"),"utf8")).module!=="LinkspanIroh")throw new Error();sourceDirectory=candidate;}
      catch{throw new Error("Resolve @jokoagent/linkspan-iroh/native-sources from the application and pass its containing directory as sourceDirectory for this optional validation tool.");}
    }
  }
  const {stdout,stderr}=await exec(javaExecutable,["-version"],{signal});if(!/version "21\./u.test(stdout+stderr))throw new Error("This native Kotlin check requires JDK21.");
  const inputs=JSON.parse(await readFile(new URL("../mobile-inputs.json",import.meta.url),"utf8"));
  const compiler=await downloadMobileInput(compilerInput,root,signal),home=join(root,"kotlin-2.2.21");
  for(const[name,bytes]of readMobileZip(await readFile(compiler),name=>/^kotlinc\/lib\/[A-Za-z0-9_.-]+\.jar$/u.test(name))){const filename=join(home,name.slice("kotlinc/".length));await mkdir(dirname(filename),{recursive:true});await writeFile(filename,bytes);}
  const sdk=await downloadMobileInput(inputs.android.irohJar,root,signal);
  const dependencies=await Promise.all(validationInputs.map(value=>downloadMobileInput(value,root,signal)));
  const classpath=[sdk,...dependencies],output=await mkdtemp(join(root,"compiled-")),jar=join(output,"native-test.jar");
  try{
    await exec(javaExecutable,["-cp",join(home,"lib/*"),"org.jetbrains.kotlin.cli.jvm.K2JVMCompiler","-kotlin-home",home,"-jvm-target","21","-classpath",classpath.join(delimiter),"-d",jar,join(sourceDirectory,"android/LinkspanIrohEngine.kt"),join(sourceDirectory,"test/NativeIrohFixture.kt")],{signal,maxBuffer:4*1024*1024});
    const result=await exec(javaExecutable,["-cp",[jar,join(home,"lib/kotlin-stdlib.jar"),...classpath].join(delimiter),"app.joko.linkspan.NativeIrohFixtureKt"],{signal,maxBuffer:4*1024*1024,timeout:30000});
    await prepareIrohMobileRuntime({directory:join(output,"android-sdk"),platform:"android",targets:["arm64-v8a","x86_64"],cacheDirectory:root,signal});
    const oldJna=await downloadMobileInput({url:"https://repo.maven.apache.org/maven2/net/java/dev/jna/jna/5.15.0/jna-5.15.0.aar",bytes:520976,sha256:"3ca530b982fa7a31f060fc532c986a92beade90ce605c8df20a18a8b9ce85f8b"},root,signal);
    const oldLibrary=readMobileZip(await readFile(oldJna),name=>name==="jni/x86_64/libjnidispatch.so").get("jni/x86_64/libjnidispatch.so");
    assert.throws(()=>verifyAndroidLibrary(oldLibrary,"x86_64"),/16KB/u);
    return `${result.stdout.trim()}\nAndroid fixed ARM64/x64 JNI inputs: matching JNA5.19.1 APIs, ABI and16KB segments verified; incompatible old JNA rejected`;
  }catch(error){throw new Error(`The actual native Kotlin check failed.\n${error.stderr??error.message}`);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(await testNativeIrohKotlin());

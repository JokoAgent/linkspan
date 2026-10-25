import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { x } from 'tar';

const run = promisify(execFile);
const sha = value=>createHash('sha256').update(value).digest('hex');
const sources = {
  rathole:{version:'0.5.0',bytes:298402,sha256:'c8698dc507c4c2f7e0032be24cac42dd6656ac1c52269875d17957001aa2de41',url:'https://codeload.github.com/rathole-org/rathole/tar.gz/v0.5.0'},
  bore:{version:'0.6.0',bytes:23378,sha256:'ab3175a6f304c7efdcacd0f6a0e4950f49eb31cb2a3ae9b4928c97ed8d03861c',url:'https://codeload.github.com/ekzhang/bore/tar.gz/v0.6.0'},
  zrok:{version:'2.0.8',bytes:26538182,sha256:'fdfc75e57e10824093290bf3be2215d6bacdf5cc7302ada80d1e6ae61b2b77ed',url:'https://codeload.github.com/openziti/zrok/tar.gz/v2.0.8'}
};
const triples={'win32-x64':'x86_64-pc-windows-msvc','win32-arm64':'aarch64-pc-windows-msvc','linux-x64':'x86_64-unknown-linux-gnu','linux-arm64':'aarch64-unknown-linux-gnu','darwin-x64':'x86_64-apple-darwin','darwin-arm64':'aarch64-apple-darwin'};

async function notice(directory) {
  const parts=[];
  for(const file of await readdir(directory))if(/^(?:licen[cs]e|copying|notice|copyright)(?:[._-][a-z0-9_.-]+)?$/iu.test(file))try{parts.push(`--- ${file} ---\n${await readFile(join(directory,file),'utf8')}`);}catch{}
  return parts.join('\n');
}

/** Source build for missing targets or required official-release features. It is
 * explicitly invoked at build/release time and keeps the upstream lockfile. */
export async function buildSourceHelper({provider,directory,target=`${process.platform}-${process.arch}`,goExecutable=process.env.LINKSPAN_GO_EXECUTABLE??'go',cargoExecutable=process.env.LINKSPAN_CARGO_EXECUTABLE??'cargo',rustcExecutable,signal}) {
  const input=sources[provider];
  if(!input||!isAbsolute(directory)||!Object.hasOwn(triples,target))throw new Error('Unsupported source helper selection.');
  const version=`${provider}-source-${input.version}`;
  const output=join(directory,version,target);await mkdir(output,{recursive:true});
  const temporary=await mkdtemp(join(output,'.build-'));
  try {
    const response=await fetch(input.url,{signal:signal??AbortSignal.timeout(180000)});
    if(!response.ok||!response.body)throw new Error('Pinned helper source unavailable.');
    const chunks=[];let count=0;for await(const chunk of response.body){count+=chunk.length;if(count>input.bytes)throw new Error('Source size mismatch.');chunks.push(chunk);}
    const bytes=Buffer.concat(chunks);if(count!==input.bytes||sha(bytes)!==input.sha256)throw new Error('Source integrity mismatch.');
    const archive=join(temporary,'source.tgz');await writeFile(archive,bytes);
    const work=join(temporary,'source');await mkdir(work);
    await x({file:archive,cwd:work,strip:1,strict:true,preservePaths:false,filter:(_path,entry)=>entry.type==='Directory'||entry.type==='File'});
    if(provider==='rathole') {
      // Upstream's build metadata dependency time 0.3.29 does not compile with
      // Rust 1.80+. This fixed lock changes only its compatible 0.3.36 closure;
      // relay protocol, crypto and runtime source stay at the selected tag.
      const lock=await readFile(fileURLToPath(new URL('../helpers/rathole/Cargo.lock',import.meta.url)));
      await writeFile(join(work,'Cargo.lock'),lock);
      const build=await readFile(join(work,'build.rs'),'utf8');
      await writeFile(join(work,'build.rs'),build+'\n// The pinned libgit2 build metadata closure uses these Windows imports.\n#[cfg(windows)]\n#[link(name = "advapi32")]\nextern "system" {}\n');
    }
    const executable=join(output,`${provider}${target.startsWith('win32-')?'.exe':''}`);
    let toolchain;let modules=[];const notices=[];const sourceNotice=await notice(work);if(!sourceNotice)throw new Error('Missing upstream source notice.');notices.push(sourceNotice);
    if(provider==='zrok') {
      const client=join(work,'.linkspan-client');await mkdir(client);
      const {copyFile}=await import('node:fs/promises');for(const name of ['main.go','main_test.go'])await copyFile(fileURLToPath(new URL(`../helpers/zrok/${name}`,import.meta.url)),join(client,name));
      const {stdout}=await run(goExecutable,['version'],{windowsHide:true,signal});toolchain=stdout.trim();if(!/^go version go1\.27\.3 /u.test(toolchain))throw new Error('Pinned Go 1.27.3 required.');
      const [platform,arch]=target.split('-');const env={...process.env,GOTOOLCHAIN:'local',GOENV:'off',GOWORK:'off',GOFLAGS:'',GOEXPERIMENT:'',GOFIPS140:'off',GOAMD64:'v1',GOARM64:'v8.0',GOOS:platform==='win32'?'windows':platform,GOARCH:arch==='x64'?'amd64':arch,CGO_ENABLED:'0'};
      await run(goExecutable,['test','-mod=readonly','./.linkspan-client'],{cwd:work,env:{...env,GOOS:process.platform==='win32'?'windows':process.platform,GOARCH:process.arch==='x64'?'amd64':process.arch},windowsHide:true,signal,maxBuffer:8*1024*1024});
      await run(goExecutable,['build','-mod=readonly','-trimpath','-buildvcs=false','-ldflags=-s -w','-o',executable,'./.linkspan-client'],{cwd:work,env,windowsHide:true,signal,maxBuffer:8*1024*1024});
      const {stdout:records}=await run(goExecutable,['list','-mod=readonly','-deps','-json','./.linkspan-client'],{cwd:work,env,windowsHide:true,signal,maxBuffer:32*1024*1024});
      const selected=new Map();for(const pkg of records.trim().split(/\r?\n(?=\{)/u).map(x=>JSON.parse(x)))if(pkg.Module?.Dir&&!pkg.Module.Main)selected.set(pkg.Module.Path,pkg.Module);
      for(const module of selected.values()){const content=await notice(module.Dir);if(!content)throw new Error(`Missing selected upstream notice: ${module.Path}`);notices.push(`=== ${module.Path} ${module.Version??''} ===\n${content}`);modules.push({path:module.Path,version:module.Version,sum:module.Sum});}
    } else {
      const rustc=rustcExecutable??(isAbsolute(cargoExecutable)?join(dirname(cargoExecutable),process.platform==='win32'?'rustc.exe':'rustc'):'rustc');
      const {stdout:cargoVersion}=await run(cargoExecutable,['--version'],{windowsHide:true,signal});const {stdout:rustVersion}=await run(rustc,['--version'],{windowsHide:true,signal});toolchain={cargo:cargoVersion.trim(),rustc:rustVersion.trim()};
      // Official Linux ARM rathole releases omit TLS. All source targets use
      // this same explicit feature set, including the verified TLS transport.
      const features=provider==='rathole'?['--no-default-features','--features','client,server,tls,noise']:[];
      const env={...process.env,RUSTC:rustc,CARGO_TARGET_DIR:join(directory,version,'cargo-cache',target)};
      await run(cargoExecutable,['build','--locked','--release','--target',triples[target],...features],{cwd:work,env,windowsHide:true,signal,maxBuffer:8*1024*1024});
      const {stdout:metadata}=await run(cargoExecutable,['metadata','--locked','--format-version','1',...features],{cwd:work,env,windowsHide:true,signal,maxBuffer:16*1024*1024});
      for(const pkg of JSON.parse(metadata).packages){const content=await notice(dirname(pkg.manifest_path));notices.push(`=== ${pkg.name} ${pkg.version} ${pkg.license??''} ===\n${content}`);modules.push({name:pkg.name,version:pkg.version,source:pkg.source,license:pkg.license});}
      const {copyFile}=await import('node:fs/promises');await copyFile(join(env.CARGO_TARGET_DIR,triples[target],'release',`${provider}${target.startsWith('win32-')?'.exe':''}`),executable);
    }
    await writeFile(join(output,'THIRD_PARTY_NOTICES.txt'),notices.join('\n\n')+'\n');
    const binary=await readFile(executable);const manifestPath=join(output,'helper-build.json');const patches={'scripts/build-source-helper.mjs':sha(await readFile(fileURLToPath(import.meta.url)))};
    if(provider==='zrok')for(const name of ['main.go','main_test.go'])patches[`helpers/zrok/${name}`]=sha(await readFile(fileURLToPath(new URL(`../helpers/zrok/${name}`,import.meta.url))));
    if(provider==='rathole')patches['helpers/rathole/Cargo.lock']=sha(await readFile(fileURLToPath(new URL('../helpers/rathole/Cargo.lock',import.meta.url))));
    const receipt={provider,version,target,upstream:input,toolchain,modules,patches,bytes:binary.length,sha256:sha(binary),lockfileSha256:sha(await readFile(join(work,provider==='zrok'?'go.sum':'Cargo.lock')))};
    await writeFile(manifestPath,JSON.stringify(receipt,null,2)+'\n');return {executable,manifestPath,...receipt};
  } finally {await rm(temporary,{recursive:true,force:true});}
}

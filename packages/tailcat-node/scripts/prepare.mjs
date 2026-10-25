import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile, cp } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const targets = { "win32-x64": ["windows","amd64"], "win32-arm64": ["windows","arm64"], "linux-x64": ["linux","amd64"], "linux-arm64": ["linux","arm64"], "darwin-x64": ["darwin","amd64"], "darwin-arm64": ["darwin","arm64"], "browser-wasm": ["js","wasm"] };

/** Build-time only; uses the published, checksum-verified Go module and fixed toolchain. */
export async function prepareTailcatRuntime({ directory, target = `${process.platform}-${process.arch}`, goExecutable = process.env.LINKSPAN_GO_EXECUTABLE ?? "go", signal } = {}) {
  if (!directory) throw new Error("An explicit artifact directory is required.");
  const selected = targets[target]; if (!selected) throw new Error("Unsupported tailcat build target.");
  const { stdout: version } = await exec(goExecutable, ["version"], { signal });
  if (!/^go version go1\.27\.3 /u.test(version)) throw new Error("The fixed Go 1.27.3 toolchain is required.");
  const destination = resolve(directory); await mkdir(destination, { recursive: true });
  const filename = join(destination, target === "browser-wasm" ? "tailcat.wasm" : target.startsWith("win32-") ? "tailcat-helper.exe" : "tailcat-helper");
  const source = fileURLToPath(new URL("../helper", import.meta.url));
  const sources = {};
  for (const name of ["go.mod","go.sum","build-tags.txt","main.go","main_wasm.go","engine/engine.go","engine/region.go"]) sources[name]=createHash("sha256").update(await readFile(join(source,name))).digest("hex");
  const tags = (await readFile(join(source,"build-tags.txt"),"utf8")).trim();
  const environment = { ...process.env, GOOS: selected[0], GOARCH: selected[1], CGO_ENABLED: "0", GOTOOLCHAIN: "local", GOWORK:"off",GOFLAGS:"",GOENV:"off",GOEXPERIMENT:"",GOAMD64:"v1",GOARM64:"v8.0",GOPROXY:"https://proxy.golang.org",GOSUMDB:"sum.golang.org",GONOSUMDB:"",GOPRIVATE:"",GOINSECURE:"" };
  await exec(goExecutable, ["build","-mod=readonly",`-tags=${tags}`,"-trimpath","-buildvcs=false","-ldflags=-buildid= -s -w","-o",filename,"."], { cwd: source, signal, maxBuffer: 8 * 1024 * 1024, env: environment });
  const {stdout:dependencyText} = await exec(goExecutable,["list","-mod=readonly",`-tags=${tags}`,"-deps","-json","."],{cwd:source,signal,env:environment,maxBuffer:32*1024*1024});
  const modules = new Map();
  for (const item of dependencyText.trim().split(/\r?\n(?=\{)/u).map(value=>JSON.parse(value))) {
    if (!item.Module?.Main && item.Module?.Dir) {
      const actual = item.Module.Replace ?? item.Module;
      modules.set(actual.Path,{...actual,Dir:actual.Dir ?? item.Module.Dir});
    }
  }
  const {stdout:goRootText} = await exec(goExecutable,["env","GOROOT"],{signal});
  const notices = [`=== Go 1.27.3 standard library ===\n${await readFile(join(goRootText.trim(),"LICENSE"),"utf8")}`];
  for (const item of [...modules.values()].sort((a,b)=>a.Path.localeCompare(b.Path))) {
    const texts = [];
    for (const name of await readdir(item.Dir)) if (/^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/iu.test(name)) {
      try { texts.push(`--- ${name} ---\n${await readFile(join(item.Dir,name),"utf8")}`); } catch {}
    }
    if (texts.length===0) throw new Error(`Missing required upstream Go license text for ${item.Path}@${item.Version}`);
    notices.push(`=== ${item.Path}@${item.Version} ${item.Sum ?? ""} ===\n${texts.join("\n")}`);
  }
  await writeFile(join(destination,"THIRD_PARTY_NOTICES.txt"),notices.join("\n\n")+"\n");
  await writeFile(join(destination,"go-dependencies.json"),JSON.stringify([...modules.values()].map(item=>({path:item.Path,version:item.Version,sum:item.Sum})),null,2)+"\n");
  if (target === "browser-wasm") {
    const { stdout: goroot } = await exec(goExecutable, ["env","GOROOT"], { signal });
    await cp(join(goroot.trim(), "lib", "wasm", "wasm_exec.js"), join(destination, "wasm_exec.js"));
  }
  const bytes = await readFile(filename);
  for(const[name,expected]of Object.entries(sources))if(createHash("sha256").update(await readFile(join(source,name))).digest("hex")!==expected)throw new Error("The Go source changed while its artifact was being prepared.");
  const receipt = { version: "0.7.0", toolchain: "go1.27.3", target, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), goModSha256: sources["go.mod"], goSumSha256: sources["go.sum"], sources,dependencyCount:modules.size,noticesSha256:createHash("sha256").update(await readFile(join(destination,"THIRD_PARTY_NOTICES.txt"))).digest("hex") };
  await writeFile(join(destination, "tailcat-runtime.json"), `${JSON.stringify(receipt,null,2)}\n`);
  return { filename, receipt };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify((await prepareTailcatRuntime({ directory: process.argv[2], target: process.argv[3] })).receipt));

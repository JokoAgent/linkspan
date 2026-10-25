import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
const exec = promisify(execFile);

/** Preserve upstream texts for the selected locked Rust dependency graph. */
export async function collectRustNotices({ cargoExecutable = "cargo", manifest, rootPackage, directory, filterPlatform, includeRoot = false, rootLicenseDirectory, signal }) {
  const args = ["metadata","--locked","--format-version","1","--manifest-path",manifest];
  if (filterPlatform) args.push("--filter-platform",filterPlatform);
  const {stdout} = await exec(cargoExecutable,args,{signal,maxBuffer:64*1024*1024});
  const metadata = JSON.parse(stdout);
  const selected = metadata.packages.find(value=>value.name===rootPackage);
  if (!selected || !metadata.resolve) throw new Error("The locked Rust dependency graph did not contain its expected root.");
  const nodes = new Map(metadata.resolve.nodes.map(value=>[value.id,value]));
  const reachable = new Set(); const queue = [selected.id];
  while (queue.length) {
    const id = queue.pop(); if (reachable.has(id)) continue; reachable.add(id);
    for (const dependency of nodes.get(id)?.dependencies ?? []) queue.push(dependency);
  }
  if (!includeRoot) reachable.delete(selected.id);
  const notices = [];
  const inventory = [];
  const missing = [];
  for (const item of metadata.packages.filter(value=>reachable.has(value.id)).sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version))) {
    const root = dirname(item.manifest_path);
    const files = new Set((await readdir(root)).filter(name=>/^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/iu.test(name)).map(name=>join(root,name)));
    if (item.license_file) files.add(resolve(root,item.license_file));
    if (item.id===selected.id && rootLicenseDirectory) {
      for (const name of await readdir(rootLicenseDirectory)) if (/^(?:licen[cs]e|copying|notice|copyright)(?:$|[._-])/iu.test(name)) files.add(join(rootLicenseDirectory,name));
    }
    const texts = [];
    for (const filename of [...files].sort()) {
      try { const bytes = await readFile(filename); texts.push(`--- ${filename.split(/[\\/]/u).at(-1)} ---\n${bytes.toString("utf8")}`); }
      catch {}
    }
    const recoveredFrom = [];
    if (texts.length===0 && /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/u.test(item.repository ?? "")) {
      let vcs;
      try { vcs = JSON.parse(await readFile(join(root,".cargo_vcs_info.json"),"utf8")); } catch {}
      if (/^[a-f0-9]{40}$/u.test(vcs?.git?.sha1 ?? "")) {
        const repository = item.repository.replace(/\.git\/?$/u,"").replace(/^https:\/\/github\.com\//u,"").replace(/\/$/u,"");
        for (const name of ["LICENSE-MIT","LICENSE-APACHE","LICENSE","LICENSE.txt","LICENSE.md","COPYING","UNLICENSE"]) {
          const url = `https://raw.githubusercontent.com/${repository}/${vcs.git.sha1}/${name}`;
          const response = await fetch(url,{signal});
          if (response.status===404) continue;
          if (!response.ok) throw new Error(`The fixed upstream license could not be read for ${item.name}@${item.version}`);
          const value = await response.text();
          if (value.length>256*1024) throw new Error("An upstream license file exceeded its size limit.");
          texts.push(`--- ${name} ---\nFixed upstream source: ${url}\n${value}`); recoveredFrom.push(url);
        }
      }
    }
    if(texts.length===0 && item.license==="Unlicense"){
      const url="https://unlicense.org/UNLICENSE";const response=await fetch(url,{signal});if(!response.ok)throw new Error("The canonical Unlicense text could not be read.");
      const bytes=Buffer.from(await response.arrayBuffer());if(createHash("sha256").update(bytes).digest("hex")!=="b5065838cbac452dfc855ba6e6e031481ad2c68406f70d21ead9321374653e6c")throw new Error("The canonical Unlicense text did not match its fixed input.");
      texts.push(`--- Unlicense as declared by the published Cargo metadata ---\nThe upstream archive omitted its license text. ${url}\n${bytes.toString("utf8")}`);recoveredFrom.push(url);
    }
    if (texts.length===0 && /(?:^|[ /])Apache-2\.0(?:$|[ )])/u.test(item.license ?? "")) {
      const url = "https://www.apache.org/licenses/LICENSE-2.0.txt";
      const response = await fetch(url,{signal});
      if (!response.ok) throw new Error("The canonical Apache-2.0 text could not be read.");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex")!=="cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30") throw new Error("The canonical Apache-2.0 text did not match its fixed input.");
      texts.push(`--- Apache-2.0 alternative selected from published Cargo metadata ---\nThe upstream archive omitted its license text. ${url}\n${bytes.toString("utf8")}`);
      recoveredFrom.push(url);
    }
    if (texts.length===0) { missing.push(`${item.name}@${item.version}`); continue; }
    inventory.push({name:item.name,version:item.version,license:item.license,source:item.source,...(recoveredFrom.length?{recoveredFrom}:{}),noticeSha256:createHash("sha256").update(texts.join("\n")).digest("hex")});
    notices.push(`=== ${item.name}@${item.version} (${item.license ?? "see upstream texts"}) ===\n${texts.join("\n")}`);
  }
  if (missing.length) throw new Error(`Missing required upstream Rust license texts: ${missing.join(", ")}`);
  await writeFile(join(directory,"THIRD_PARTY_NOTICES.txt"),notices.join("\n\n")+"\n");
  await writeFile(join(directory,"rust-dependencies.json"),JSON.stringify(inventory,null,2)+"\n");
  return inventory;
}

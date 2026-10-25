import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp,readFile,readdir,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { downloadFixedArchive } from "../scripts/toolchains.mjs";

test("fixed tool downloads stream to disk, verify cache, and reject wrong hashes and exact-size overruns",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"linkspan-fixed-tool-test-"));t.after(()=>rm(directory,{recursive:true,force:true}));
  const bytes=Buffer.alloc(1024*1024,37);const hash=createHash("sha256").update(bytes).digest("hex");let requests=0;
  const server=createServer((request,response)=>{requests++;response.write(bytes.subarray(0,100));response.end(bytes.subarray(100));});server.listen(0,"127.0.0.1");await once(server,"listening");t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  const filename=await downloadFixedArchive(`${base}/tool.tgz`,hash,bytes.length,directory);
  assert.deepEqual(await readFile(filename),bytes);await downloadFixedArchive(`${base}/tool.tgz`,hash,bytes.length,directory);assert.equal(requests,1);
  await assert.rejects(downloadFixedArchive(`${base}/wrong.tgz`,"0".repeat(64),bytes.length,directory),/integrity/u);
  await assert.rejects(downloadFixedArchive(`${base}/large.tgz`,hash,100,directory),/size/u);
  assert.deepEqual(await readdir(directory),["tool.tgz"]);
});

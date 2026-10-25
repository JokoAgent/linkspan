import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import {createRequire} from "node:module";
import {pathToFileURL,fileURLToPath} from "node:url";
import {chromium} from "playwright-core";

const require=createRequire(new URL("../../noise/package.json",import.meta.url));
const {build}=await import(pathToFileURL(require.resolve("esbuild")).href);
const files=new Map();
for(const [name,entry,wasm]of[
  ["iroh","../dist/browser.js","../../iroh-wasm/dist/runtime/linkspan_iroh_bg.wasm"],
  ["tailcat","../../tailcat/dist/browser.js","../../tailcat-wasm/dist/runtime/tailcat.wasm"],
]){
  const source=new URL(entry,import.meta.url);
  const result=await build({entryPoints:[fileURLToPath(source)],bundle:true,write:false,format:"iife",globalName:"selectedLinkspan",platform:"browser",target:"es2022",logLevel:"silent"});
  files.set(`/${name}.js`,{type:"text/javascript",bytes:result.outputFiles[0].contents});
  files.set(`/${name}.wasm`,{type:"application/wasm",bytes:await readFile(new URL(wasm,import.meta.url))});
}
const server=createServer((request,response)=>{
  if(request.url==="/"){response.writeHead(200,{"content-type":"text/html","cache-control":"no-store"});response.end("<!doctype html><meta charset=utf-8><title>Trusted SDK runtime check</title>");return;}
  const file=files.get(request.url);if(!file){response.writeHead(404);response.end();return;}
  response.writeHead(200,{"content-type":file.type,"cache-control":"no-store"});response.end(file.bytes);
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,...(process.env.LINKSPAN_BROWSER_EXECUTABLE?{executablePath:process.env.LINKSPAN_BROWSER_EXECUTABLE}:{})});
try{
  const page=await browser.newPage();const requests=[];page.on("request",request=>requests.push(request.url()));
  await page.goto(origin);assert.deepEqual(requests,[origin+"/"]);
  const first=await page.evaluate(async()=>{
    await new Promise((resolve,reject)=>{const script=document.createElement("script");script.src="/iroh.js";script.onload=resolve;script.onerror=reject;document.head.append(script);});
    const bytes=new Uint8Array(await(await fetch("/iroh.wasm")).arrayBuffer());
    await globalThis.selectedLinkspan.initializeIrohWasm(bytes);
    const identity=await globalThis.selectedLinkspan.createIrohIdentity();
    return{privateKey:/^[a-f0-9]{64}$/.test(identity.privateKey),publicKey:/^[a-f0-9]{64}$/.test(identity.publicKey)};
  });
  assert.deepEqual(first,{privateKey:true,publicKey:true});
  assert.equal(requests.some(value=>value.includes("tailcat")),false);
  const second=await page.evaluate(async()=>{
    await new Promise((resolve,reject)=>{const script=document.createElement("script");script.src="/tailcat.js";script.onload=resolve;script.onerror=reject;document.head.append(script);});
    const bytes=new Uint8Array(await(await fetch("/tailcat.wasm")).arrayBuffer());
    await globalThis.selectedLinkspan.initializeTailcatWasm(bytes);
    const identity=await globalThis.selectedLinkspan.createTailcatIdentity();
    const host=globalThis.selectedLinkspan.createTailcatBridgeHost();
    const viaBridge=await host.request({method:"identity",streamId:"0".repeat(32)});host.dispose();
    return{privateKey:/^privkey:[a-f0-9]{64}$/.test(identity.privateKey),publicKey:/^nodekey:[a-f0-9]{64}$/.test(identity.publicKey),bridgeKey:/^privkey:[a-f0-9]{64}$/.test(viaBridge.privateKey)};
  });
  assert.deepEqual(second,{privateKey:true,publicKey:true,bridgeKey:true});
  assert.equal(requests.some(value=>!value.startsWith(origin+"/")),false);
  assert.deepEqual(requests.filter(value=>value.endsWith(".wasm")).sort(),[origin+"/iroh.wasm",origin+"/tailcat.wasm"].sort());
  console.log(JSON.stringify({runtimeBindings:"actual Chrome IIFE and WASM",iroh:first,tailcat:second,unselectedBackendFetch:false,externalRequests:false}));
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { get } from 'node:https';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { x as extractTar } from 'tar';
import { prepareConnectorHelper, connectorHelperArtifact } from '../dist/artifacts.js';
import { startConnector } from '../dist/index.js';
import { origin, cert, caCert, key, budget } from './fixtures/origin.mjs';

const execute=promisify(execFile);
const enabled=process.env.LINKSPAN_HELPER_RELEASE_TESTS==='1';
const cleanups=new WeakMap();
function retire(t,fn){const list=cleanups.get(t);if(list)list.push(fn);else t.after(fn);}
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function serverProcess(t,executable,args,ready) {
  let seenExit=false;let close;const closed=new Promise(resolve=>{close=resolve;});
  const environment={RUST_LOG:'info',NO_COLOR:'1'};for(const name of ['SystemRoot','WINDIR'])if(process.env[name])environment[name]=process.env[name];
  const child=spawn(executable,args,{env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.once('close',()=>{seenExit=true;close();});child.on('error',()=>{});
  const started=new Promise((resolve,reject)=>{
    // Only fixed local test identities/configuration reach this fixture. Keep
    // bounded startup diagnostics so a missing upstream feature is actionable.
    child.once('error',reject);child.once('close',(code,signal)=>reject(new Error(`The pinned test relay exited before readiness (code=${code}, signal=${signal}): ${buffer.slice(-4096)}`)));
    let buffer='';const observe=chunk=>{buffer=(buffer+chunk.toString('utf8')).slice(-16384);if(buffer.includes(ready))resolve();};
    child.stdout.on('data',observe);child.stderr.on('data',observe);
  });
  let stop;
  retire(t,()=>stop??=(async()=>{if(!seenExit)child.kill('SIGTERM');await closed;})());
  return started;
}
async function requestCarrier(port){return new Promise((resolve,reject)=>get({hostname:'127.0.0.1',port,servername:'carrier.test',ca:caCert,agent:false,headers:{host:'carrier.test',authorization:'Bearer carrier-secret'}},response=>{let value='';response.on('data',part=>value+=part);response.once('end',()=>resolve(value));}).once('error',reject));}
async function fixture(t,provider){
  const base=fileURLToPath(new URL('../../../.runtime/relay-fixtures/',import.meta.url));await mkdir(base,{recursive:true,mode:0o700});
  const directory=await mkdtemp(join(base,`linkspan-${provider}-relay-`));const list=[];cleanups.set(t,list);t.after(async()=>{try{for(const cleanup of list.reverse())await cleanup();}finally{await rm(directory,{recursive:true,force:true});}});
  // Source-only targets share compiled dependency caches across their Noise
  // and TLS cases, while each relay retains an isolated private configuration.
  const helper=await prepareConnectorHelper({provider,directory:join(base,'prepared-helpers')});
  const serverCert=join(directory,'server.pem');const serverKey=join(directory,'server.key');await writeFile(serverCert,cert);await writeFile(serverKey,key);
  const serverCa=join(directory,'ca.pem');await writeFile(serverCa,caCert);
  const app=await origin(t,(req,res)=>{assert.equal(req.headers.authorization,'Bearer carrier-secret');res.end('protected carrier reply');});
  return {directory,helper,serverCert,serverCa,serverKey,app,gateway:await freePort(),control:await freePort()};
}
async function frpsExecutable(value){
  const selected=connectorHelperArtifact('frp');
  const response=await fetch(selected.url);if(!response.ok)throw new Error('Pinned relay fixture release unavailable.');
  const archive=Buffer.from(await response.arrayBuffer());assert.equal(archive.length,selected.archiveBytes);assert.equal(createHash('sha256').update(archive).digest('hex'),selected.archiveSha256);
  const entry=selected.entry.replace(/frpc(\.exe)?$/u,(_value,extension)=>'frps'+(extension??''));
  const executable=join(value.directory,process.platform==='win32'?'frps.exe':'frps');
  if(selected.format==='zip'){
    const files=unzipSync(archive,{filter:value=>value.name===entry&&value.originalSize<128*1024*1024});assert.ok(files[entry]);await writeFile(executable,files[entry]);
  }else{
    const temporary=join(value.directory,'frps-archive');await mkdir(temporary);const path=join(temporary,'release.tgz');await writeFile(path,archive);
    await extractTar({file:path,cwd:temporary,strict:true,preservePaths:false,filter:(path,entryValue)=>path===entry&&entryValue.type==='File'&&entryValue.size<128*1024*1024});
    await writeFile(executable,await readFile(join(temporary,entry)));
  }
  await chmod(executable,0o700);return executable;
}

for(const mode of ['tcp','https'])test(`fixed upstream frp ${mode} carries authenticated host TLS through a real local relay`,{skip:!enabled,timeout:180000},async t=>{
  const value=await fixture(t,'frp');const executable=await frpsExecutable(value);const config=join(value.directory,'frps.toml');
  await writeFile(config,`bindAddr = "127.0.0.1"\nbindPort = ${value.control}\nauth.method = "token"\nauth.token = "test-publisher"\ntransport.tls.force = true\ntransport.tls.certFile = ${JSON.stringify(value.serverCert)}\ntransport.tls.keyFile = ${JSON.stringify(value.serverKey)}\n${mode==='https'?`vhostHTTPSPort = ${value.gateway}\n`:''}`);
  await serverProcess(t,executable,['-c',config],'frps started successfully');
  const carrier=await startConnector({provider:'frp',mode,helper:value.helper,serverAddress:'127.0.0.1',serverPort:value.control,token:'test-publisher',serverName:'carrier.test',serverCaPool:value.serverCa,remotePort:value.gateway,publicOrigin:`https://carrier.test:${value.gateway}`,budget},value.app.options);retire(t,()=>carrier.close());
  assert.equal(await requestCarrier(value.gateway),'protected carrier reply');await carrier.close();await carrier.closed;
});
for(const mode of ['noise','tls'])test(`fixed upstream rathole ${mode} carries authenticated host TLS through a real local relay`,{skip:!enabled,timeout:180000},async t=>{
  const value=await fixture(t,'rathole');let serverTransport,clientTransport;
  if(mode==='noise'){
    const {stdout}=await execute(value.helper.executable,['--genkey'],{windowsHide:true});const keys=stdout.match(/[A-Za-z0-9+/]{43}=/gu);assert.equal(keys.length,2);
    serverTransport=`[server.transport]\ntype = "noise"\n[server.transport.noise]\nlocal_private_key = ${JSON.stringify(keys[0])}\n`;clientTransport={type:'noise',remotePublicKey:keys[1]};
  }else{
    const pfx=join(value.directory,'identity.pfx');await writeFile(pfx,Buffer.from((await readFile(new URL('./fixtures/identity.pfx.base64',import.meta.url),'utf8')).trim(),'base64'));
    serverTransport=`[server.transport]\ntype = "tls"\n[server.transport.tls]\npkcs12 = ${JSON.stringify(pfx)}\npkcs12_password = "fixture-only"\n`;clientTransport={type:'tls',hostname:'carrier.test',trustedRoot:value.serverCa};
  }
  const config=join(value.directory,'server.toml');await writeFile(config,`[server]\nbind_addr = "127.0.0.1:${value.control}"\n${serverTransport}\n[server.services.encrypted]\nbind_addr = "127.0.0.1:${value.gateway}"\ntoken = "test-publisher"\n`);
  await serverProcess(t,value.helper.executable,['--server',config],`Listening at 127.0.0.1:${value.control}`);
  const carrier=await startConnector({provider:'rathole',helper:value.helper,remoteAddress:`127.0.0.1:${value.control}`,serviceName:'encrypted',token:'test-publisher',transport:clientTransport,publicOrigin:`https://carrier.test:${value.gateway}`,budget},value.app.options);retire(t,()=>carrier.close());
  assert.equal(await requestCarrier(value.gateway),'protected carrier reply');await carrier.close();await carrier.closed;
});
test('fixed upstream bore carries authenticated host TLS through its real local relay',{skip:!enabled,timeout:180000},async t=>{
  const value=await fixture(t,'bore');
  await serverProcess(t,value.helper.executable,['server','--bind-addr','127.0.0.1','--min-port',String(value.gateway),'--max-port',String(value.gateway),'--secret','test-publisher'],'server listening');
  const carrier=await startConnector({provider:'bore',helper:value.helper,serverAddress:'127.0.0.1',remotePort:value.gateway,secret:'test-publisher',publicOrigin:`https://carrier.test:${value.gateway}`,budget},value.app.options);retire(t,()=>carrier.close());
  assert.equal(await requestCarrier(value.gateway),'protected carrier reply');await carrier.close();await carrier.closed;
});

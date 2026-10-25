import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
import { get } from 'node:https';
import { get as getHttp } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { x as extractTar } from 'tar';
import { prepareConnectorHelper, connectorHelperArtifact } from '../dist/artifacts.js';
import { startConnector } from '../dist/index.js';
import { startDatagramMapping } from '../dist/datagram.js';
import { connectHttpConnectStream, createNodeStreamCarrier } from '@jokoagent/linkspan-http-connect/node';
import { createIdentity, connectStream, acceptStream } from '@jokoagent/linkspan-noise';
import { createHttpFetch } from '@jokoagent/linkspan-http';
import { serveHttp } from '@jokoagent/linkspan-http/node';
import { createServer as createHttpServer } from 'node:http';
import { origin, cert, caCert, key, budget } from './fixtures/origin.mjs';

const execute=promisify(execFile);
const enabled=process.env.LINKSPAN_HELPER_RELEASE_TESTS==='1';
const preparedHelpers=new Map();
const fixtureBase=fileURLToPath(new URL('../../../.runtime/relay-fixtures/',import.meta.url));
if(enabled)before(async context=>{
  await mkdir(fixtureBase,{recursive:true,mode:0o700});
  // Missing upstream targets compile from fixed source (notably Windows ARM64
  // rathole). Keep that build outside the carrier's bounded behavior check and
  // share the exact prepared executable between its Noise and TLS cases.
  for(const provider of ['frp','rathole','bore'])preparedHelpers.set(provider,await prepareConnectorHelper({provider,directory:join(fixtureBase,'prepared-helpers'),signal:context.signal}));
},{timeout:600000});
const cleanups=new WeakMap();
function retire(t,fn){const list=cleanups.get(t);if(list)list.push(fn);else t.after(fn);}
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
function serverProcess(t,executable,args,ready) {
  let seenExit=false;let close;const closed=new Promise(resolve=>{close=resolve;});
  const environment={RUST_LOG:'info',NO_COLOR:'1'};for(const name of ['SystemRoot','WINDIR'])if(process.env[name])environment[name]=process.env[name];
  const child=spawn(executable,args,{env:environment,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.once('close',()=>{seenExit=true;close();});child.on('error',()=>{});
  // Keep observation attached before either control or public listener starts.
  // A control authentication receipt is not an upstream socket-bind receipt.
  let buffer='';const observers=new Set();
  const observe=chunk=>{buffer=(buffer+chunk.toString('utf8')).slice(-16384);for(const notify of observers)notify();};
  child.stdout.on('data',observe);child.stderr.on('data',observe);
  const waitFor=pattern=>{
    const pending=new Promise((resolve,reject)=>{
      const finish=error=>{observers.delete(check);child.removeListener('error',failed);child.removeListener('close',exited);t.signal.removeEventListener('abort',aborted);if(error)reject(error);else resolve();};
      const failed=error=>finish(error);
      const exited=(code,signal)=>finish(new Error(`The pinned test relay exited before readiness (code=${code}, signal=${signal}): ${buffer.slice(-4096)}`));
      const aborted=()=>finish(t.signal.reason);
      const check=()=>{if(seenExit)exited(child.exitCode,child.signalCode);else if(typeof pattern==='string'?buffer.includes(pattern):pattern.test(buffer.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu,'')))finish();};
      observers.add(check);child.once('error',failed);child.once('close',exited);t.signal.addEventListener('abort',aborted,{once:true});
      if(t.signal.aborted)aborted();else check();
    });
    void pending.catch(()=>{});return pending;
  };
  const started=waitFor(ready);started.waitFor=waitFor;
  let stop;
  retire(t,()=>stop??=(async()=>{if(!seenExit)child.kill('SIGTERM');await closed;})());
  return started;
}
async function requestCarrier(port){return new Promise((resolve,reject)=>get({hostname:'127.0.0.1',port,servername:'carrier.test',ca:caCert,agent:false,headers:{host:'carrier.test',authorization:'Bearer carrier-secret'}},response=>{let value='';response.on('data',part=>value+=part);response.once('end',()=>resolve(value));}).once('error',reject));}
async function requestHttpCarrier(port){return new Promise((resolve,reject)=>getHttp({hostname:'127.0.0.1',port,agent:false,headers:{host:'carrier.test',authorization:'Bearer carrier-secret'}},response=>{let value='';response.on('data',part=>value+=part);response.once('end',()=>resolve(value));}).once('error',reject));}
async function udpSocket(t,echo=false){const socket=createSocket('udp4');if(echo)socket.on('message',(data,remote)=>socket.send(data,remote.port,remote.address));await new Promise(resolve=>socket.bind(0,'127.0.0.1',resolve));retire(t,()=>new Promise(resolve=>socket.close(resolve)));return socket;}
async function udpRoundtrip(socket,port,bytes){return new Promise((resolve,reject)=>{const end=setTimeout(()=>{clearInterval(retry);socket.removeListener('message',received);reject(new Error('The fixed UDP relay did not return its packet.'));},5000);const received=packet=>{if(!packet.equals(bytes))return;clearTimeout(end);clearInterval(retry);socket.removeListener('message',received);resolve(packet);};socket.on('message',received);const send=()=>socket.send(bytes,port,'127.0.0.1');const retry=setInterval(send,100);send();});}
async function fixture(t,provider){
  const directory=await mkdtemp(join(fixtureBase,`linkspan-${provider}-relay-`));const list=[];cleanups.set(t,list);t.after(async()=>{try{for(const cleanup of list.reverse())await cleanup();}finally{await rm(directory,{recursive:true,force:true});}});
  const helper=preparedHelpers.get(provider);assert.ok(helper,'The fixed helper must be prepared before carrier verification.');
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

for(const mode of ['tcp','http','https'])test(`fixed upstream frp ${mode} carries authenticated host TLS through a real local relay`,{skip:!enabled,timeout:180000},async t=>{
  const value=await fixture(t,'frp');const executable=await frpsExecutable(value);const config=join(value.directory,'frps.toml');
  await writeFile(config,`bindAddr = "127.0.0.1"\nbindPort = ${value.control}\nauth.method = "token"\nauth.token = "test-publisher"\ntransport.tls.force = true\ntransport.tls.certFile = ${JSON.stringify(value.serverCert)}\ntransport.tls.keyFile = ${JSON.stringify(value.serverKey)}\n${mode==='https'?`vhostHTTPSPort = ${value.gateway}\n`:mode==='http'?`vhostHTTPPort = ${value.gateway}\n`:''}`);
  await serverProcess(t,executable,['-c',config],'frps started successfully');
  const carrier=await startConnector({provider:'frp',mode,helper:value.helper,serverAddress:'127.0.0.1',serverPort:value.control,token:'test-publisher',serverName:'carrier.test',serverCaPool:value.serverCa,remotePort:value.gateway,publicOrigin:`https://carrier.test:${value.gateway}`,budget},value.app.options);retire(t,()=>carrier.close());
  assert.equal(await (mode==='http'?requestHttpCarrier(value.gateway):requestCarrier(value.gateway)),'protected carrier reply');await carrier.close();await carrier.closed;
});
test('fixed upstream frp tcpmux CONNECT carries pinned Noise and large HTTP bodies with original-owner cancellation',{skip:!enabled,timeout:180000},async t=>{
  const value=await fixture(t,'frp');const executable=await frpsExecutable(value);const config=join(value.directory,'frps.toml');
  await writeFile(config,`bindAddr = "127.0.0.1"\nbindPort = ${value.control}\nauth.method = "token"\nauth.token = "test-publisher"\ntransport.tls.force = true\ntransport.tls.certFile = ${JSON.stringify(value.serverCert)}\ntransport.tls.keyFile = ${JSON.stringify(value.serverKey)}\ntcpmuxHTTPConnectPort = ${value.gateway}\ntcpmuxPassthrough = false\n`);
  await serverProcess(t,executable,['-c',config],'frps started successfully');
  const identity=await createIdentity();const sockets=new Set(),tasks=new Set();let businessRequests=0;
  const payload=Buffer.alloc(4*1024*1024);for(let index=0;index<payload.length;index++)payload[index]=index%251;
  const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
  const app=createHttpServer(async(request,response)=>{
    businessRequests++;assert.equal(request.headers.authorization,'Bearer encrypted-business-only');
    const hash=createHash('sha256');let size=0;for await(const chunk of request){hash.update(chunk);size+=chunk.length;}
    assert.equal(size,payload.length);assert.equal(hash.digest('hex'),digest(payload));response.writeHead(200,{'content-type':'application/octet-stream'});response.end(payload);
  });
  const track=socket=>{sockets.add(socket);socket.once('close',()=>sockets.delete(socket));socket.on('error',()=>{});};app.on('connection',track);
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  const owner=new AbortController();
  const target=createServer({pauseOnConnect:true,allowHalfOpen:true},socket=>{
    track(socket);const task=acceptStream(createNodeStreamCarrier(socket,{signal:owner.signal}),{identity,signal:owner.signal,deadline:Date.now()+5000})
      .then(channel=>serveHttp(channel,{origin:`http://127.0.0.1:${app.address().port}`,signal:owner.signal})).catch(()=>{});
    tasks.add(task);void task.finally(()=>tasks.delete(task));
  });
  await new Promise(resolve=>target.listen(0,'127.0.0.1',resolve));
  retire(t,async()=>{owner.abort();for(const socket of sockets)socket.destroy();await Promise.all(tasks);await Promise.all([new Promise(resolve=>target.close(resolve)),new Promise(resolve=>app.close(resolve))]);});
  const selected={provider:'frp',mode:'tcpmux',helper:value.helper,serverAddress:'127.0.0.1',serverPort:value.control,token:'test-publisher',serverName:'carrier.test',serverCaPool:value.serverCa,publicOrigin:'https://carrier.test',publicProxyOrigin:`http://127.0.0.1:${value.gateway}`,budget:{...budget,maximumSessionMs:30000,maximumBytes:24*1024*1024}};
  let receipt;
  const carrier=await startConnector(selected,{requestId:'tcpmux-original',encryptedStreamTarget:{address:'127.0.0.1',port:target.address().port},signal:owner.signal,onResource(resource){receipt=resource;}});retire(t,()=>carrier.close());
  assert.equal(carrier.publicOrigin,'https://carrier.test');assert.equal(receipt.requestId,'tcpmux-original');assert.equal(receipt.provider,'frp');assert.ok(receipt.processId);
  const connect=async options=>connectStream(await connectHttpConnectStream({proxyOrigin:selected.publicProxyOrigin,authority:'carrier.test:443',...options}),{expectedPublicKey:identity.publicKey,...options});
  const fetch=createHttpFetch({origin:carrier.publicOrigin,connect});
  const response=await fetch('https://carrier.test/private/upload-ticket',{method:'PUT',headers:{authorization:'Bearer encrypted-business-only'},body:payload});
  assert.equal(response.status,200);assert.equal(digest(new Uint8Array(await response.arrayBuffer())),digest(payload));assert.equal(businessRequests,1);
  await assert.rejects(connectHttpConnectStream({proxyOrigin:selected.publicProxyOrigin,authority:'unregistered.test:443'}),{code:'transport_error'});
  assert.equal(businessRequests,1);
  const wrong=await createIdentity();
  await assert.rejects(connectStream(await connectHttpConnectStream({proxyOrigin:selected.publicProxyOrigin,authority:'carrier.test:443'}),{expectedPublicKey:wrong.publicKey}),{code:'identity_mismatch'});
  assert.equal(businessRequests,1);
  const sessionOwner=new AbortController();const channel=await connect({signal:sessionOwner.signal});
  const pending=assert.rejects(channel.receive(),{code:'cancelled'});sessionOwner.abort();await pending;
  assert.equal(businessRequests,1);owner.abort();await carrier.closed;await carrier.close();
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
  const relay=serverProcess(t,value.helper.executable,['--server',config],`Listening at 127.0.0.1:${value.control}`);await relay;
  // v0.5.0 sends Ack::Ok before spawning the public service bind. Observe the
  // owned server's exact completed log line, then make the original single GET.
  const listening=relay.waitFor(new RegExp(`Listening at 127\\.0\\.0\\.1:${value.gateway}\\r?\\n`,'u'));
  const carrier=await startConnector({provider:'rathole',helper:value.helper,remoteAddress:`127.0.0.1:${value.control}`,serviceName:'encrypted',token:'test-publisher',transport:clientTransport,publicOrigin:`https://carrier.test:${value.gateway}`,budget},value.app.options);retire(t,()=>carrier.close());
  await listening;
  assert.equal(await requestCarrier(value.gateway),'protected carrier reply');await carrier.close();await carrier.closed;
});
test('fixed upstream bore carries authenticated host TLS through its real local relay',{skip:!enabled,timeout:180000},async t=>{
  const value=await fixture(t,'bore');
  await serverProcess(t,value.helper.executable,['server','--bind-addr','127.0.0.1','--min-port',String(value.gateway),'--max-port',String(value.gateway),'--secret','test-publisher'],'server listening');
  const carrier=await startConnector({provider:'bore',helper:value.helper,serverAddress:'127.0.0.1',remotePort:value.gateway,secret:'test-publisher',publicOrigin:`https://carrier.test:${value.gateway}`,budget},value.app.options);retire(t,()=>carrier.close());
  assert.equal(await requestCarrier(value.gateway),'protected carrier reply');await carrier.close();await carrier.closed;
});

test('fixed upstream frp UDP preserves packet boundaries through a real authenticated relay',{skip:!enabled,timeout:180000},async t=>{
  const value=await fixture(t,'frp');const executable=await frpsExecutable(value);const config=join(value.directory,'frps.toml');
  await writeFile(config,`bindAddr = "127.0.0.1"\nbindPort = ${value.control}\nauth.method = "token"\nauth.token = "test-publisher"\ntransport.tls.force = true\ntransport.tls.certFile = ${JSON.stringify(value.serverCert)}\ntransport.tls.keyFile = ${JSON.stringify(value.serverKey)}\n`);
  await serverProcess(t,executable,['-c',config],'frps started successfully');
  const target=await udpSocket(t,true);const remote=await udpSocket(t);
  const mapping=await startDatagramMapping({provider:'frp',helper:value.helper,serverAddress:'127.0.0.1',serverPort:value.control,token:'test-publisher',serverName:'carrier.test',serverCaPool:value.serverCa,remotePort:value.gateway,publicHost:'127.0.0.1',publicPort:value.gateway,budget},{requestId:'frp-udp-original',localTarget:{address:'127.0.0.1',port:target.address().port,ownerId:'capture-original'}});retire(t,()=>mapping.close());
  for(const bytes of [Buffer.from([0,255,16,0]),Buffer.from('separate-packet'),Buffer.alloc(1500,217)])assert.deepEqual(await udpRoundtrip(remote,value.gateway,bytes),bytes);
  assert.equal(mapping.mapping.ownerId,'capture-original');await mapping.close();await mapping.closed;
});
for(const mode of ['noise','tls'])test(`fixed upstream rathole UDP over ${mode} preserves packets through a real authenticated relay`,{skip:!enabled,timeout:180000},async t=>{
  const value=await fixture(t,'rathole');let serverTransport,transport;
  if(mode==='noise'){
    const {stdout}=await execute(value.helper.executable,['--genkey'],{windowsHide:true});const keys=stdout.match(/[A-Za-z0-9+/]{43}=/gu);assert.equal(keys.length,2);
    serverTransport=`[server.transport]\ntype = "noise"\n[server.transport.noise]\nlocal_private_key = ${JSON.stringify(keys[0])}\n`;transport={type:'noise',remotePublicKey:keys[1]};
  }else{
    const pfx=join(value.directory,'identity.pfx');await writeFile(pfx,Buffer.from((await readFile(new URL('./fixtures/identity.pfx.base64',import.meta.url),'utf8')).trim(),'base64'));
    serverTransport=`[server.transport]\ntype = "tls"\n[server.transport.tls]\npkcs12 = ${JSON.stringify(pfx)}\npkcs12_password = "fixture-only"\n`;transport={type:'tls',hostname:'carrier.test',trustedRoot:value.serverCa};
  }
  const config=join(value.directory,'server.toml');await writeFile(config,`[server]\nbind_addr = "127.0.0.1:${value.control}"\n${serverTransport}\n[server.services.media]\ntype = "udp"\nbind_addr = "127.0.0.1:${value.gateway}"\ntoken = "test-publisher"\n`);
  await serverProcess(t,value.helper.executable,['--server',config],`Listening at 127.0.0.1:${value.control}`);
  const target=await udpSocket(t,true);const remote=await udpSocket(t);
  const controller=new AbortController();let receipt;
  const mapping=await startDatagramMapping({provider:'rathole',helper:value.helper,remoteAddress:`127.0.0.1:${value.control}`,serviceName:'media',token:'test-publisher',transport,publicHost:'127.0.0.1',publicPort:value.gateway,budget},{requestId:`rathole-udp-${mode}`,signal:controller.signal,onResource(value){receipt=value;},localTarget:{address:'127.0.0.1',port:target.address().port,ownerId:'capture-original'}});retire(t,()=>mapping.close());
  assert.equal(receipt.requestId,`rathole-udp-${mode}`);assert.equal(receipt.provider,'rathole');assert.ok(receipt.processId);
  for(const bytes of [Buffer.from([0,255,16,0]),Buffer.from('separate-packet'),Buffer.alloc(2048,217)])assert.deepEqual(await udpRoundtrip(remote,value.gateway,bytes),bytes);
  controller.abort();await mapping.closed;await mapping.close();
});

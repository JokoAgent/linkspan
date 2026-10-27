import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { get } from 'node:https';
import ssh2 from 'ssh2';
import { start } from '../dist/index.js';
import { cert, caCert, key, budget, origin } from '../../connectors/test/fixtures/origin.mjs';

async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;}
test('real ssh2 reverse bind carries host TLS bytes, pins SSH identity, and closes only its listener',{timeout:20000},async t=>{
  let authorizationAttempts=0;const plaintext=[];const clients=new Set();const listeners=new Set();
  const gatewayPort=await freePort();
  const server=new ssh2.Server({hostKeys:[key]},client=>{
    const owned=new Set();
    clients.add(client);client.on('error',()=>{});client.once('close',()=>{clients.delete(client);for(const gateway of owned)gateway.close();});
    client.on('authentication',context=>{authorizationAttempts++;context.method==='password'&&context.username==='publisher'&&context.password==='publisher-key'?context.accept():context.reject();});
    client.on('ready',()=>client.on('request',(accept,reject,name,info)=>{
      if(name==='tcpip-forward'){
        const gateway=createServer(incoming=>{
          client.forwardOut('127.0.0.1',info.bindPort,incoming.remoteAddress,incoming.remotePort,(error,stream)=>{
            if(error){incoming.destroy();return;}stream.on('error',()=>incoming.destroy());incoming.on('error',()=>stream.destroy());
            incoming.on('data',value=>plaintext.push(value));incoming.pipe(stream);stream.pipe(incoming);
          });
        });
        listeners.add(gateway);owned.add(gateway);gateway.on('error',reject);gateway.listen(info.bindPort,'127.0.0.1',()=>accept(info.bindPort));
      }else if(name==='cancel-tcpip-forward'){for(const gateway of listeners)gateway.close();accept();}
      else reject();
    }));
  });
  server.on('error',()=>{});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{for(const client of clients)client.end();for(const gateway of listeners)gateway.close();await new Promise(resolve=>server.close(resolve));});
  const app=await origin(t,(req,res)=>{assert.equal(req.headers.authorization,'Bearer business-only-inside-host-TLS');res.end('authorized response');});
  const publicKey=ssh2.utils.parseKey(key).getPublicSSH();
  const config={provider:'ssh',host:'127.0.0.1',port:server.address().port,username:'publisher',password:'publisher-key',hostKeySha256:`SHA256:${createHash('sha256').update(publicKey).digest('base64').replace(/=+$/u,'')}`,remoteBindAddress:'127.0.0.1',remotePort:gatewayPort,publicOrigin:`https://127.0.0.1:${gatewayPort}`,budget};
  const carrier=await start(config,app.options);t.after(()=>carrier.close());
  const body=await new Promise((resolve,reject)=>get(carrier.publicOrigin,{ca:caCert,agent:false,headers:{authorization:'Bearer business-only-inside-host-TLS'}},response=>{let result='';response.on('data',value=>result+=value);response.once('end',()=>resolve(result));}).once('error',reject));
  assert.equal(body,'authorized response');assert.equal(Buffer.concat(plaintext).includes('business-only-inside-host-TLS'),false);
  const prior=authorizationAttempts;
  await assert.rejects(start({...config,hostKeySha256:'SHA256:'+'A'.repeat(43)},{...app.options,requestId:'wrong-host-key'}));
  assert.equal(authorizationAttempts,prior);
  await carrier.close();await carrier.closed;
  await assert.rejects(new Promise((resolve,reject)=>get(carrier.publicOrigin,{ca:caCert,agent:false},resolve).once('error',reject)));
});

for (const phase of ['authentication', 'tcpip-forward']) test(`cancelling SSH during ${phase} closes the actual connection`, { timeout: 10000 }, async t => {
  let reached; const pending = new Promise(resolve => { reached = resolve; });
  let disconnected; const closed = new Promise(resolve => { disconnected = resolve; });
  const clients = new Set();
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {});
    client.once('close', () => { clients.delete(client); disconnected(); });
    client.on('authentication', context => { if (phase === 'authentication') reached(); else context.accept(); });
    client.on('ready', () => client.on('request', (_accept, _reject, name) => { if (name === 'tcpip-forward') reached(); }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of clients) client.destroy(); await new Promise(resolve => server.close(resolve)); });
  const app = await origin(t), controller = new AbortController();
  const hostKeySha256 = `SHA256:${createHash('sha256').update(ssh2.utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/u, '')}`;
  const operation = start({ provider: 'ssh', host: '127.0.0.1', port: server.address().port, username: 'publisher', password: 'private', hostKeySha256,
    remoteBindAddress: '127.0.0.1', remotePort: 23456, publicOrigin: 'https://carrier.example', budget }, { ...app.options, signal: controller.signal });
  const result = assert.rejects(operation, { code: 'outcome_unknown' });
  await pending; controller.abort(); await result; await closed;
  assert.equal(clients.size, 0);
});

test('SSH close retires its private session without a cancel-forward acknowledgement', { timeout: 10000 }, async t => {
  let disconnected; const closed = new Promise(resolve => { disconnected = resolve; });
  const clients = new Set();
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.once('close', () => { clients.delete(client); disconnected(); });
    client.on('authentication', context => context.accept());
    client.on('ready', () => client.on('request', (accept, _reject, name, info) => { if (name === 'tcpip-forward') accept(info.bindPort); }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const client of clients) client.destroy(); await new Promise(resolve => server.close(resolve)); });
  const app = await origin(t);
  const hostKeySha256 = `SHA256:${createHash('sha256').update(ssh2.utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/u, '')}`;
  const carrier = await start({ provider: 'ssh', host: '127.0.0.1', port: server.address().port, username: 'publisher', password: 'private', hostKeySha256,
    remoteBindAddress: '127.0.0.1', remotePort: 23456, publicOrigin: 'https://carrier.example', budget }, app.options);
  t.after(() => carrier.close());
  await carrier.close(); await carrier.closed; await closed;
  assert.equal(clients.size, 0);
});

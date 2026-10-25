import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile, copyFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { x } from 'tar';

const run = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = { version:'1.19.0', url:'https://codeload.github.com/fosrl/newt/tar.gz/1.19.0', bytes:361713, sha256:'98c9df97d2c06fa1bc4b19cbb2c5ec551a9ca1c40e0e98719d3307ec90f8b159' };
const hash = value => createHash('sha256').update(value).digest('hex');

export async function preparePangolinSource({ directory, signal }) {
  if (!isAbsolute(directory)) throw new Error('An absolute build directory is required.');
  const base = join(directory, 'pangolin-embedded-1');
  await mkdir(base, {recursive:true});
  const work = await mkdtemp(join(base, '.source-'));
  const archive = join(base, 'newt.tgz');
  let bytes;
  try { bytes = await readFile(archive); } catch {
    const response = await fetch(source.url, {signal: signal ?? AbortSignal.timeout(180000)});
    if (!response.ok || !response.body) throw new Error('Pinned Newt source unavailable.');
    let size=0; const chunks=[];
    for await(const chunk of response.body) { size+=chunk.length; if(size>source.bytes)throw new Error('Source size mismatch.');chunks.push(chunk); }
    bytes=Buffer.concat(chunks);
    if(bytes.length!==source.bytes || hash(bytes)!==source.sha256)throw new Error('Source integrity mismatch.');
    await writeFile(archive,bytes,{flag:'wx'});
  }
  if(bytes.length!==source.bytes || hash(bytes)!==source.sha256)throw new Error('Source integrity mismatch.');
  const upstream = join(work,'upstream'); await mkdir(upstream,{recursive:true});
  await x({file:archive,cwd:upstream,strip:1,strict:true,preservePaths:false,filter:(_path,entry)=>entry.type==='File'||entry.type==='Directory'});
  const exactReplace = async (path, before, after) => {
    const content = await readFile(path,'utf8');
    if(content.split(before).length!==2)throw new Error('Pinned upstream patch context changed.');
    await writeFile(path,content.replace(before,after));
  };
  await exactReplace(join(upstream,'websocket/client.go'),'func (c *Client) RegisterHandler(messageType string, handler MessageHandler) {','func (c *Client) RegisterHandler(messageType string, handler MessageHandler) {\n\thandler = restrictLinkspanHandler(messageType, handler)\n\tif handler == nil { return }');
  await exactReplace(join(upstream,'websocket/client.go'),'\tc.conn = conn','\tconn.SetReadLimit(1048576)\n\tc.conn = conn');
  await exactReplace(join(upstream,'websocket/client.go'),'data, err = io.ReadAll(gr)','data, err = io.ReadAll(io.LimitReader(gr, 1048577))');
  await exactReplace(join(upstream,'websocket/client.go'),'\t\t\t\tgr.Close()','\t\t\t\tgr.Close()\n\t\t\t\tif len(data) > 1048576 { continue }');
  await exactReplace(join(upstream,'websocket/client.go'),'client := &http.Client{}','client := &http.Client{Timeout:15*time.Second, Transport:&http.Transport{Proxy:nil,MaxResponseHeaderBytes:16384}, CheckRedirect:func(*http.Request,[]*http.Request)error{return fmt.Errorf("redirect_refused")}}');
  await exactReplace(join(upstream,'websocket/client.go'),'body, _ := io.ReadAll(resp.Body)','body, readErr := io.ReadAll(io.LimitReader(resp.Body, 65537)); if readErr != nil || len(body) > 65536 { return "", fmt.Errorf("bounded_auth_response_failed") }');
  await copyFile(join(root,'helpers/pangolin/restricted-websocket.go'),join(upstream,'websocket/linkspan_carrier.go'));
  await copyFile(join(root,'helpers/pangolin/restricted-websocket_test.go'),join(upstream,'websocket/linkspan_carrier_test.go'));
  await writeFile(join(upstream,'newt/linkspan_carrier.go'),'package newt\n\nvar LinkspanCarrierReady func()\n');
  await exactReplace(join(upstream,'newt/connect.go'),'if err = n.pm.Start(); err != nil {\n\t\tlogger.Error("Failed to start proxy manager: %v", err)\n\t}', 'if err = n.pm.Start(); err != nil {\n\t\tlogger.Error("Failed to start proxy manager: %v", err)\n\t} else if LinkspanCarrierReady != nil { LinkspanCarrierReady() }');
  await writeFile(join(upstream,'proxy/linkspan_carrier.go'),'package proxy\n\nvar LinkspanMaximumUDPPeers = 64\nvar LinkspanMaximumDatagramBytes = 2048\nvar LinkspanUDPSlots = make(chan struct{},64)\n');
  await exactReplace(join(upstream,'proxy/manager.go'),'\t\tclientKey := remoteAddr.String()','\t\tif n > LinkspanMaximumDatagramBytes { continue }\n\t\tclientKey := remoteAddr.String()');
  await exactReplace(join(upstream,'proxy/manager.go'),'\t\tif !exists {\n\t\t\ttargetUDPAddr, err := net.ResolveUDPAddr("udp", targetAddr)','\t\tif !exists {\n\t\t\tclientsMutex.RLock(); full := len(clientConns) >= LinkspanMaximumUDPPeers; clientsMutex.RUnlock(); if full { continue }\n\t\t\ttargetUDPAddr, err := net.ResolveUDPAddr("udp", targetAddr)');
  await exactReplace(join(upstream,'proxy/manager.go'),'\t\t\ttargetUDPAddr, err := net.ResolveUDPAddr("udp", targetAddr)','\t\t\tselect {case LinkspanUDPSlots<-struct{}{}:default:continue}\n\t\t\ttargetUDPAddr, err := net.ResolveUDPAddr("udp", targetAddr)');
  await exactReplace(join(upstream,'proxy/manager.go'),'\t\t\t\tlogger.Error("Error resolving target address: %v", err)','\t\t\t\t<-LinkspanUDPSlots\n\t\t\t\tlogger.Error("Error resolving target address: %v", err)');
  await exactReplace(join(upstream,'proxy/manager.go'),'\t\t\ttargetConn, err = net.DialUDP("udp", nil, targetUDPAddr)\n\t\t\tif err != nil {','\t\t\ttargetConn, err = net.DialUDP("udp", nil, targetUDPAddr)\n\t\t\tif err != nil {\n\t\t\t\t<-LinkspanUDPSlots');
  await exactReplace(join(upstream,'proxy/manager.go'),'\t\t\tgo func(clientKey string, targetConn *net.UDPConn, remoteAddr net.Addr, tunnelID string) {','\t\t\tgo func(clientKey string, targetConn *net.UDPConn, remoteAddr net.Addr, tunnelID string) {\n\t\t\t\tdefer func(){<-LinkspanUDPSlots}()');
  await exactReplace(join(upstream,'proxy/manager.go'),'\t\t\t\t\t// bytes from target -> client (direction=out)','\t\t\t\t\tif n > LinkspanMaximumDatagramBytes { continue }\n\t\t\t\t\t// bytes from target -> client (direction=out)');
  for(const name of ['go.mod','main.go','go.sum']) {
    try { await copyFile(join(root,'helpers/pangolin',name),join(work,name)); }
    catch(error) { if(name!=='go.sum'||error.code!=='ENOENT')throw error; }
  }
  const common = join(work,'common'); await mkdir(common,{recursive:true});
  const module = await readFile(join(work,'go.mod'),'utf8'); await writeFile(join(work,'go.mod'),module.replace('=> ../common','=> ./common'));
  for(const name of await readdir(join(root,'helpers/common'))) if(name==='go.mod'||name.endsWith('.go')) await copyFile(join(root,'helpers/common',name),join(common,name));
  return {work,upstream};
}

export async function buildPangolinHelper({directory,target=`${process.platform}-${process.arch}`,goExecutable=process.env.LINKSPAN_GO_EXECUTABLE??'go',signal}) {
  if(!['win32-x64','win32-arm64','linux-x64','linux-arm64','darwin-x64','darwin-arm64'].includes(target))throw new Error('Unsupported embedded target.');
  const {stdout:version}=await run(goExecutable,['version'],{windowsHide:true,signal});
  if(!/^go version go1\.27\.3 /u.test(version))throw new Error('Pinned Go 1.27.3 required.');
  const {work,upstream}=await preparePangolinSource({directory,signal});
  const [platform,arch]=target.split('-');
  const env={...process.env,GOTOOLCHAIN:'local',GOENV:'off',GOWORK:'off',GOFLAGS:'',GOEXPERIMENT:'',GOFIPS140:'off',GOAMD64:'v1',GOARM64:'v8.0',CGO_ENABLED:'0',GOOS:platform==='win32'?'windows':platform,GOARCH:arch==='x64'?'amd64':arch};
  await run(goExecutable,['test','-mod=readonly','./websocket','-run','^TestCarrier'],{cwd:upstream,env:{...env,GOOS:process.platform==='win32'?'windows':process.platform,GOARCH:process.arch==='x64'?'amd64':process.arch},windowsHide:true,signal,maxBuffer:8*1024*1024});
  const output=join(directory,'pangolin-embedded-1',target);await mkdir(output,{recursive:true});
  const executable=join(output,`linkspan-pangolin${target.startsWith('win32-')?'.exe':''}`);
  await run(goExecutable,['build','-mod=readonly','-trimpath','-buildvcs=false','-ldflags=-s -w','-o',executable,'.'],{cwd:work,env,windowsHide:true,signal,maxBuffer:8*1024*1024});
  const {stdout}=await run(goExecutable,['list','-mod=readonly','-deps','-json','.'],{cwd:work,env,windowsHide:true,signal,maxBuffer:32*1024*1024});
  const modules=new Map();for(const pkg of stdout.trim().split(/\r?\n(?=\{)/u).map(x=>JSON.parse(x)))if(pkg.Module?.Dir&&!pkg.Module.Main&&!pkg.Module.Path.startsWith('linkspan.invalid/'))modules.set(pkg.Module.Path,pkg.Module);
  const notices=[];
  for(const module of modules.values()) {
    const texts=[];for(const name of await readdir(module.Dir))if(/^(?:licen[cs]e|copying|notice|copyright)(?:[._-][a-z0-9_.-]+)?$/iu.test(name))try{texts.push(`--- ${name} ---\n${await readFile(join(module.Dir,name),'utf8')}`);}catch{}
    if(!texts.length)throw new Error(`Missing upstream notice: ${module.Path}`);notices.push(`=== ${module.Path} ${module.Version??''} ===\n${texts.join('\n')}`);
  }
  await writeFile(join(output,'THIRD_PARTY_NOTICES.txt'),notices.join('\n\n')+'\n');
  const binary=await readFile(executable);const sources={};for(const folder of ['helpers/pangolin','helpers/common'])for(const name of await readdir(join(root,folder)))if(name==='go.mod'||name==='go.sum'||name.endsWith('.go'))sources[`${folder}/${name}`]=hash(await readFile(join(root,folder,name)));
  sources['scripts/build-pangolin-helper.mjs']=hash(await readFile(fileURLToPath(import.meta.url)));
  const manifestPath=join(output,'helper-build.json');
  const receipt={provider:'pangolin',version:'pangolin-embedded-1',upstream:source,target,toolchain:version.trim(),sources,bytes:binary.length,sha256:hash(binary)};
  await writeFile(manifestPath,JSON.stringify(receipt,null,2)+'\n');await rm(work,{recursive:true,force:true});return {executable,manifestPath,...receipt};
}

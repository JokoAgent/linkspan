import { createServer } from 'node:https';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const key = await readFile(new URL('./private-key.pem', import.meta.url));
// A separate test CA signs a serverAuth leaf with a 397-day lifetime; Apple
// enforces these certificate constraints: https://support.apple.com/103769
export const cert = await readFile(new URL('./certificate.pem', import.meta.url));
export const caCert = await readFile(new URL('./root-ca.pem', import.meta.url));
export const budget = { paidEnabled:false, maximumSessionMs:10000, maximumBytes:4*1024*1024 };
export async function origin(t, handler = (_req,res)=>res.end('ok')) {
  const directory = await mkdtemp(join(tmpdir(),'linkspan-carrier-test-'));
  const ca = join(directory,'ca.pem'); await writeFile(ca,caCert);
  const server = createServer({key,cert},handler); server.on('tlsClientError',()=>{});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
  return {server,options:{requestId:'fixed-test-operation',localOrigin:`https://127.0.0.1:${server.address().port}`,originServerName:'carrier.test',originCaPool:ca}};
}

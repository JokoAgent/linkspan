import test from 'node:test';
import assert from 'node:assert/strict';
import { start, preparePinggySdk, verifyPinggySdk } from '../dist/index.js';
test('Pinggy SSH is explicit and requires independently pinned server identity',async()=>{
  await assert.rejects(start({provider:'pinggy',runtime:'ssh',mode:'http',budget:{paidEnabled:false,maximumSessionMs:1000,maximumBytes:1024}},{}),{code:'invalid_argument'});
  await assert.rejects(start({provider:'pinggy',mode:'http'},{}),{code:'invalid_argument'});
});
test('unsupported SDK ABI or relative prepared paths never trigger a native download',async()=>{
  await assert.rejects(preparePinggySdk({directory:process.cwd(),nodeAbi:'not-a-supported-runtime'}),{code:'unavailable'});
  await assert.rejects(verifyPinggySdk('relative'),{code:'invalid_argument'});
});
test('Pinggy TCP/TLSTCP reject missing endpoint trust or paid consent before runtime effects',async()=>{
  const budget={paidEnabled:false,maximumSessionMs:1000,maximumBytes:1024};
  for(const mode of ['tls','tcp','tlstcp'])await assert.rejects(start({provider:'pinggy',runtime:'sdk',sdkDirectory:'not-prepared',mode,budget},{}),{code:'invalid_argument'});
  await assert.rejects(start({provider:'pinggy',runtime:'sdk',sdkDirectory:'not-prepared',mode:'tlstcp',tlstcpEndpoint:'tcp',publicOrigin:'https://public.example',budget},{}),{code:'invalid_argument'});
});

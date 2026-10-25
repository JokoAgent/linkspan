import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute=promisify(execFile);
test('the selected optional Pinggy UDP runtime has bounded owned lifecycle',async()=>{
  await execute(process.execPath,['--experimental-test-module-mocks','--test',fileURLToPath(new URL('./pinggy-datagram.mock.mjs',import.meta.url))],{windowsHide:true,timeout:10000});
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../dist/index.js';
test('ngrok rejects unsupported modes and ambiguous passthrough origins before SDK startup',async()=>{
  await assert.rejects(start({provider:'ngrok',mode:'labeled',authtoken:'publisher'},{}),{code:'invalid_argument'});
  await assert.rejects(start({provider:'ngrok',mode:'tcp',authtoken:'publisher'},{}),{code:'invalid_argument'});
});

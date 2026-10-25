import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../dist/index.js';
test('reverse SSH cannot start without a fixed trusted server host-key fingerprint',async()=>{
  await assert.rejects(start({provider:'ssh',host:'relay.example',username:'publisher',remoteBindAddress:'0.0.0.0',remotePort:443,hostKeySha256:'',password:'publisher-password',publicOrigin:'https://entry.example'},{}),{code:'invalid_argument'});
});

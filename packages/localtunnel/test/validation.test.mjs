import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../dist/index.js';
test('localtunnel refuses an insecure resource endpoint and invalid requested names before contacting the provider',async()=>{
  await assert.rejects(start({provider:'localtunnel',host:'http://relay.example'},{}),{code:'invalid_argument'});
  await assert.rejects(start({provider:'localtunnel',subdomain:'name\nsecret'},{}),{code:'invalid_argument'});
});

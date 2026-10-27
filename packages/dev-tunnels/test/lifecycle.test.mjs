import test from 'node:test';
import assert from 'node:assert/strict';
import { TunnelRelayTunnelHost } from '@microsoft/dev-tunnels-connections';
import { TunnelManagementHttpClient } from '@microsoft/dev-tunnels-management';
import { start } from '../dist/index.js';
import { budget, origin } from '../../connectors/test/fixtures/origin.mjs';

test('Dev Tunnels cancellation disposes its pending official host and a late port forwarder', { timeout: 10000 }, async t => {
  let reached, finish; const connecting = new Promise(resolve => { reached = resolve; });
  let release; const forwarding = new Promise(resolve => { release = resolve; });
  let pendingForward, forwarderCloses = 0, hostCloses = 0, managerCloses = 0;
  t.mock.method(TunnelManagementHttpClient.prototype, 'dispose', async () => { managerCloses++; });
  t.mock.method(TunnelRelayTunnelHost.prototype, 'dispose', async () => { hostCloses++; finish?.(); });
  t.mock.method(TunnelRelayTunnelHost.prototype, 'connect', async function () {
    pendingForward = this.forwardPort({ localForwardedPorts: [], forwardFromRemotePort: () => forwarding }, { portNumber: 443 });
    reached(); await new Promise(resolve => { finish = resolve; });
  });
  const app = await origin(t), controller = new AbortController();
  const operation = start({ provider: 'dev-tunnels', tunnelId: 'original', clusterId: 'use', hostAccessToken: 'private', port: 443, publicOrigin: 'https://entry.example', budget }, { ...app.options, signal: controller.signal });
  const outcome = assert.rejects(operation, { code: 'outcome_unknown' });
  await connecting; controller.abort(); await outcome;
  release({ dispose() { forwarderCloses++; } }); await pendingForward;
  assert.equal(hostCloses, 1); assert.equal(managerCloses, 1); assert.equal(forwarderCloses, 1);
});

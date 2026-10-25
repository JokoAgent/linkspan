# Linkspan Cloudflare connector

Node-only, opt-in wrapper for a managed cloudflared **2026.10.3-linkspan.1** process. It has
no dependency on a host's API, authorization, database, or private key.
Importing the package and reading metadata perform no network or process work.

```js
import { prepareCloudflared, startQuickTunnel } from '@jokoagent/linkspan-cloudflare'

// Build/packaging step only. Requires Git and the pinned Go 1.27.3 toolchain.
// Only the selected target's executable is built from fixed source and patch.
const helper = await prepareCloudflared({ directory: '/absolute/build/helpers' })

// Runtime: a prepared binary is required. It is verified before execution.
// Record requestId in the host's operation store before this external effect.
const tunnel = await startQuickTunnel({
  requestId: 'publish-2026-10-25',
  executable: helper.executable,
  localOrigin: 'https://127.0.0.1:4400', // dedicated encrypted carrier listener
  originCaPool: '/absolute/host-approved/public-certificates.pem',
  originServerName: 'origin.example', // fixed identity in the origin certificate
  onSpawn: ({ processId, requestId }) => recordOwnedProcessSync(requestId, processId),
  signal: lifetime.signal
})
console.log(tunnel.publicOrigin)
await tunnel.close()
```

The local target must be a separate listener exposing only an authenticated,
encrypted application carrier. HTTPS, certificate validation against the
host-approved public certificate bundle, and a fixed certificate server name
are required. The wrapper copies only bounded public PEM certificates into the
child's directory; no private key or option to disable TLS validation is accepted.
Do not pass a general host HTTP/API server. The
connector transfers ciphertext; host business keys and endpoint private keys
are never inputs. This is process separation, not an operating system sandbox.

`cloudflaredArtifact(target?)` returns immutable metadata without starting or
downloading anything. Supported helper targets are `win32-x64`, `win32-arm64`, `linux-x64`,
`linux-arm64`, `darwin-x64`, and `darwin-arm64`. Cross-target preparation is
supported; execution requires the actual host target. The package does not
include other targets' binaries or a browser/WASM implementation. Application
clients connect using the host's common secure WSS path and do not need this
package or a separately installed network application.

`prepareCloudflared` builds only on an explicit call, verifies exact source and
executable sizes and SHA-256 digests, rejects an existing mismatched helper, and keeps source and
license metadata beside the prepared executable. `verifyCloudflared` always
compares against the built-in manifest. Runtime startup never downloads or
updates code. Include only the selected prepared target in a host's artifact.

`startQuickTunnel` performs one creation attempt with a stable request identity.
It waits for both the temporary URL and a registered carrier connection. A
signal or absolute deadline closes the active lease; startup has a bounded
timeout. `close()` is idempotent and waits for the owned child to exit, escalating
termination after five seconds and reporting unconfirmed cleanup after ten.
Unexpected exit is observable through `closed`; the wrapper never silently
recreates a tunnel or changes its hostname. The host decides whether to retry
and how to restore business cursors and unknown operation outcomes.
The handle exposes the actual `processId`; `onSpawn` lets a host synchronously
save it in its already claimed operation immediately after spawn. If that
callback fails, startup waits for the owned child to stop before rejecting.
The library synchronously terminates its held child object on normal parent
exit or an uncaught exception, removing these listeners after child cleanup.
After an uncatchable parent termination, a host must reconcile its recorded
resource before creating another one. A recorded PID alone never authorizes
killing a possibly unrelated process that later reused it.

The process receives a generated empty configuration, an isolated home and
temporary directory, a fixed loopback target, disabled automatic updates, and
a small environment allowlist. It does not inherit provider/business secrets,
proxy settings, a user's cloudflared configuration, or remote-managed tunnel
tokens. Helper logs are bounded and consumed internally; their contents are
never exposed as diagnostics.

The wrapper uses the restricted helper with a fixed HTTP/2 edge protocol. Its
source patch rejects remote ingress updates, arbitrary TCP forwarding, and
internal management routes before dispatch; QUIC/UDP is unavailable on this selected protocol. An upstream binary
with only fixed CLI arguments is insufficient and is rejected by verification.
The helper still is not an operating system sandbox. Exact source, patch,
toolchain and target hashes are recorded in `UPSTREAM.md` and the build inputs.

Quick Tunnels are an account-free development/reference path with a temporary
`trycloudflare.com` hostname, no uptime guarantee, and a limit of 200 concurrent
in-flight requests (excess requests receive HTTP 429). They do not support SSE.
The application carrier uses WSS; applications must retain heartbeat,
cancellation, reconnection, and operation recovery because Cloudflare may close
idle sessions or sessions during deployments. A named tunnel with a stable
hostname is an independently configured deployment choice. This wrapper does
not accept remote-managed tokens or arbitrary ingress configuration.

Official behavior: [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/),
[WebSockets](https://developers.cloudflare.com/network/websockets/).
Licensing and exact source input are recorded in `UPSTREAM.md`.

The separate `@jokoagent/linkspan-cloudflare/turn` entry exports
`issueCloudflareTurnCredentials(access, options)` and
`revokeCloudflareTurnCredentials(access, resource, options)`. `access` contains
only the selected key ID, a `readApiToken(signal)` callback and an optional
host-controlled fetch implementation. The host records `options.requestId`
before dispatch; generation has no upstream idempotency or query API. A lost,
timed-out or malformed generation result is `outcome_unknown` and must not be
regenerated automatically. Resources are private handles for exactly the issued
usernames; retirement never deletes a shared TURN key. Short-lived credentials
and host authorization are separate, and TURN carries no application bearer.
Responses and calls are bounded to 16 KiB and three seconds, with explicit TTL
up to 24 hours. The adapter removes STUN-only entries and returns generic TURN
URLs, credentials and expiry. Hosts apply their own ICE contract and authorize
renewal. The API supports individual username revocation; the effect on an
already established allocation requires live verification.

No supplier account, paid resource or plan upgrade is created by these calls.
Using an existing account remains subject to that account's traffic quota and
billing settings. No provider-specific client SDK or WASM is needed.
API evidence: [credential generation and revocation](https://developers.cloudflare.com/realtime/turn/generate-credentials/).

`startNamedTunnel` uses the same restricted helper and fixed CA/SNI origin with
`accountId`, `tunnelId`, a private locally managed 32-byte `tunnelSecret`, and an
existing public HTTPS hostname. It writes a private local credential file and
one fixed local ingress. It does not accept remote-managed ingress tokens or
enable visitor Access authentication.

`createNamedTunnelSecret`, `createNamedTunnel`, `findNamedTunnel`, and
`deleteNamedTunnel` manage that locally configured resource. The host records
the original random operation and secret before creation. Name-only discovery
returns an unowned candidate. An exact `expectedResource` lookup cannot create a
replacement. Ambiguous dispatched writes remain unknown; cleanup verifies the
original account/ID/name/local configuration before deletion. DNS/CNAME setup
for the owned hostname remains a separate deployment action. Real account,
regional/network and hosted stream checks are distinct from API/helper tests.

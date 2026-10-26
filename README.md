# Linkspan

Application connections with pinned endpoint identity, authenticated encryption,
bounded flow control, cancellation and explicit resource ownership. Hosts supply
trust and application authorization. Linkspan has no dependency on a particular
host, RPC schema, device model, database or account service.

| Package | Purpose | Runtime installation |
| --- | --- | --- |
| `@jokoagent/linkspan-core` | ByteChannel, errors and operation lifetimes | No dependencies |
| `@jokoagent/linkspan-noise` | Pinned Noise over ordinary WebSocket | Core; bundled pure JS security implementation |
| `@jokoagent/linkspan-http` | Optional concurrent HTTP streams and Fetch adapter | Core; Node bridge is a separate entry |
| `@jokoagent/linkspan-cloudflare` | Explicitly prepared, managed server connector | Node-only; no helper downloaded on installation |
| `@jokoagent/linkspan-connectors` | Public carrier lifecycle, fixed helper preparation, management and separate UDP mappings | Selected provider packages/helpers only; [mode matrix](packages/connectors/README.md) |
| `@jokoagent/linkspan-connector-runtime` | Bounded fixed-origin runtime shared by selected providers | Core; no vendor SDK |
| `@jokoagent/linkspan-ngrok`, `-ssh`, `-pinggy`, `-dev-tunnels`, `-localtunnel` | Independently selected SDK carriers | Only the chosen SDK and its documented upstream dependencies |
| `@jokoagent/linkspan-iroh`, `-tailcat` | Pinned peer streams using the same authenticated Noise channel | Optional Node or browser/native binding |
| `@jokoagent/linkspan-iroh-node`, `-tailcat-node` | Selected-target native runtime preparation | Build-time preparation; no default native payload in source archives |
| `@jokoagent/linkspan-iroh-wasm`, `-tailcat-wasm` | Browser and trusted Mobile bridge runtimes | Separate real WASM resources, loaded only when selected |
| `@jokoagent/linkspan-iroh-services` | Short-lived relay-use capabilities for exact peer identities | Host-only private signing secret; separate small WASM signer |
| `@jokoagent/linkspan-tailcat-runtime` | Shared private tailcat address/key validation | Core; no vendor runtime |
| `@jokoagent/linkspan-turn` | Explicit Twilio Token and coturn REST issuance and TTL retirement | Server-only signing; original host media authority required |
| `@jokoagent/linkspan-webrtc` | Bounded reliable ordered RTC data channels with trusted DTLS pinning | Existing platform RTC engine; no unrelated SDK |
| `@jokoagent/linkspan-webrtc-node` | Explicitly selected Node WebRTC engine | werift 0.25.2; no WASM/native binary or other backend |

The initial security implementation is `@libp2p/noise@17.0.7`, using its
Noise XX handshake, signed Ed25519 identity and ChaCha20-Poly1305 transport.
The upstream browser implementation is bundled for Node, Web and React Native;
it contains no native binary or WASM. Upstream dependencies and their licenses
are pinned and included in the security package. The host supplies a full
`ed25519:<64 lowercase hex digits>` public key obtained through a trusted channel.
Missing or conflicting trust is an error. No application data is sent before
verification. A carrier's certificate, DNS name or self-reported identity does
not establish endpoint trust.

```js
import { connectWebSocket } from '@jokoagent/linkspan-noise';
import { createHttpFetch } from '@jokoagent/linkspan-http';

const secureFetch = createHttpFetch({
  origin: 'https://your-published-endpoint.example',
  connect: options => connectWebSocket({
    url: 'wss://your-published-endpoint.example/_linkspan',
    expectedPublicKey: trustedEndpointKey,
    ...options
  })
});
const response = await secureFetch('https://your-published-endpoint.example/api', {
  headers: { authorization: applicationCredential },
  signal: abortController.signal
});
// Consume or cancel response.body. Disconnect does not undo a business effect.
```

Browser hosts should import the security/HTTP modules when the user selects a
connection path. Configuration presentation must not initialize a connector or
preload unused backends. Ordinary WSS clients do not install Cloudflare's helper.
React Native hosts provide secure `crypto.getRandomValues`, TextEncoder/Decoder,
WebSocket and Web ReadableStream primitives before loading the module. The HTTP
Fetch adapter streams bytes without passing them through RN's buffering Request
polyfill. Its RN response facade supports streams and single-consumer byte/text/
JSON/blob reads; multipart parsing and cloning use a streaming native Response
where that runtime supplies one. Hosts must enforce their own content budgets.

Deploy the server connector against a dedicated encrypted listener. Never point
it at an application's unencrypted API or file server. The server HTTP bridge
accepts only a fixed loopback target and keeps business permissions with the
host. Media uses the host's authenticated signaling and media engine; WSS is not
TURN. Full network routing, TUN and network-member management are external.

Cloudflare Quick Tunnels are an account-free reference carrier intended for
testing and development: temporary names, 200 in-flight requests, no SLA and no
SSE. This implementation carries streams over WSS. It does not request paid
resources or add a supplier login for clients. Managed helper preparation verifies
the exact OS/CPU artifact before packaging; runtime never downloads or updates
it. Supported helper targets and exact inputs are in the connector package.

An untrusted relay can block traffic and observe connection metadata. Client
HTML, JavaScript, native code and updates must themselves be loaded from a trusted
source. A first Web page served by the adversarial relay cannot establish this
trust from its own script or SRI. Key replacement and lost-key recovery require a
host-authorized trusted channel. Linkspan does not decide whom a host should trust.

Hosted TURN is available through the server-only
`@jokoagent/linkspan-cloudflare/turn` entry. The host supplies a limited token
reader and an already recorded operation ID. Issuance returns generic ICE
material, expiry and an exact private revocation handle; it never receives a
host user, device, media permission or business bearer. Unknown issuance is
reported without retry. The host rechecks media authority and owns recovery.

The selected Cloudflare helper is a fixed source build with a minimal patch
rejecting platform ingress replacement, arbitrary TCP targets and internal
management routes. Only HTTP/WSS is enabled. Build preparation requires Git and
Go 1.27.3; startup verifies the restricted binary and never downloads code.

Build independently with Node 24.16+ and pnpm 11.22:

```sh
pnpm install --frozen-lockfile
pnpm check
```

`pnpm pack:artifacts` verifies optional distribution packages and their notices.
The consuming project selects its dependency source and update workflow.

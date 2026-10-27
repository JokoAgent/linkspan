# Linkspan

Application connections with pinned endpoint identity, authenticated encryption,
bounded flow control, cancellation and explicit resource ownership. Hosts supply
trust and application authorization. Linkspan has no dependency on a particular
host, RPC schema, device model, database or account service.

| Package | Purpose | Runtime installation |
| --- | --- | --- |
| [core](packages/core/README.md) | ByteChannel, errors and operation lifetimes | No dependencies |
| [noise](packages/noise/README.md) | Pinned Noise over WebSocket or a byte stream | Core; bundled pure JS security implementation |
| [http](packages/http/README.md) | Concurrent HTTP streams and Fetch adapter | Core; separate Node bridge entry |
| [http-connect](packages/http-connect/README.md) | Native/Node CONNECT carrier and public tcpmux endpoints | Core; private fixed parser and separate TCP/TLS entry |
| [connectors](packages/connectors/README.md), [connector-runtime](packages/connector-runtime/README.md) | Public TCP/UDP carriers, budgets and resource management | Selected helper or optional ngrok/SSH/Pinggy/Dev Tunnels/localtunnel package |
| [cloudflare](packages/cloudflare/README.md) | Restricted managed helper, named resources and TURN | Node-only; explicit build preparation |
| [iroh](packages/iroh/README.md), [tailcat](packages/tailcat/README.md) | Pinned peer streams | Selected Node, native or WASM binding; separate relay capability signer |
| [webrtc](packages/webrtc/README.md), [webrtc-node](packages/webrtc-node/README.md) | Reliable ordered RTC channels with trusted DTLS pinning | Platform engine or explicitly selected private Node engine |
| [turn](packages/turn/README.md) | Twilio/coturn issuance and TTL retirement | Server-only; original host media authority required |

The [Noise package](packages/noise/README.md) documents the fixed security
implementation, runtime primitives and included dependency notices.
The host supplies a full
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
HTTP CONNECT is an explicit native/Node carrier: authenticate the inner stream
with Noise and the full endpoint pin before using the HTTP adapter. Embedded
hosts supply native TCP; ordinary browsers cannot issue CONNECT through Fetch.
The [HTTP adapter](packages/http/README.md) documents React Native streaming
and response support. Hosts supply the required runtime primitives and content
budgets; HTTP-only installations do not load the CONNECT parser or native SDKs.

Deploy the server connector against a dedicated encrypted listener. Never point
it at an application's unencrypted API or file server. The server HTTP bridge
accepts only a fixed loopback target and keeps business permissions with the
host. Media uses the host's authenticated signaling and media engine; WSS is not
TURN. Full network routing, TUN and network-member management are external.

Provider modes, account requirements and local budgets are maintained in the
[carrier matrix](packages/connectors/README.md). Cloudflare Quick is a development
carrier; helper targets, restrictions and fixed build inputs belong to the
[Cloudflare package](packages/cloudflare/README.md). Runtime never downloads or
updates helpers.

An untrusted relay can block traffic and observe connection metadata. Client
HTML, JavaScript, native code and updates must themselves be loaded from a trusted
source. A first Web page served by the adversarial relay cannot establish this
trust from its own script or SRI. Key replacement and lost-key recovery require a
host-authorized trusted channel. Linkspan does not decide whom a host should trust.

TURN issuance returns ICE material, expiry and an exact private revocation
handle. Hosts record the operation before issuance, recheck media authority and
recover unknown results without creating another resource. Cloudflare TURN uses
the separate server-only `@jokoagent/linkspan-cloudflare/turn` entry.

Use the toolchains pinned in [package.json](package.json) and the
[six-platform workflow](.github/workflows/ci.yml):

```sh
pnpm install --frozen-lockfile
pnpm check
```

For source consumers, provide Git, Go and rustup, install dependencies, then run
`pnpm build:consumers <empty-output-directory>`. It builds the JavaScript and browser runtimes and emits
ordinary package directories with source provenance. Internal development
dependencies accept the consumer's selected source packages without requiring a
published version. The builder installs its Rust target and selects its Go
toolchain; it does not change global toolchain defaults.

`pnpm pack:artifacts` separately verifies distributable packages and required
notices. Neither command publishes packages or creates release tags. Runtime
never downloads library code or helpers.


# Linkspan Noise WebSocket channels

`@jokoagent/linkspan-noise@0.1.0` exposes authenticated binary channels over an
ordinary WebSocket carrier. It uses the maintained `@libp2p/noise@17.0.7`
implementation of `Noise_XX_25519_ChaChaPoly_SHA256`; Linkspan does not implement
a cryptographic algorithm, key derivation, or handshake.

```js
import { createIdentity, connectWebSocket, acceptWebSocket } from "@jokoagent/linkspan-noise";

const identity = await createIdentity(); // Host saves privateKey in protected storage.
const channel = await connectWebSocket({
  url: "wss://example.invalid/linkspan",
  expectedPublicKey: trustedEndpointPublicKey,
});
await channel.send(applicationBytes);
const reply = await channel.receive();
await channel.close();
```

The host must obtain the complete `ed25519:<64 lowercase hex digits>` public key
through an independently trusted path. Neither a hostname, CA certificate, self
reported identity, nor the same untrusted relay can supply a replacement pin.
`createIdentity()` and `identityFromPrivateKey(bytes)` return a host-owned
protobuf-encoded private key and its public key. The library keeps no identity
store. `acceptWebSocket(socket, {identity})` authenticates the connecting key but
grants no business authority; pairing, credentials, devices, revocation, and
authorization remain with the host. No application bytes are delivered or sent
until the complete endpoint handshake and expected-key verification succeed.
Upstream key/session logging is permanently disabled.

`connectWebSocket` accepts WSS, or WS on a literal loopback/localhost address for
local IPC and connector origins. A host may explicitly set
`allowInsecureWebSocket: true` for another WS carrier after applying its own
network policy, for example an approved private LAN. This changes only the
carrier policy: pinned Noise authentication and encryption are still required.
WS can expose metadata and can be blocked by browser mixed-content policy.
The library rejects URL credentials and fragments. The
optional `createSocket(url)` allows a host-supplied browser-compatible socket;
server sockets from Node `ws` are accepted directly. WebSocket compression must
be disabled at the server. The normal handshake has a 10-second upper bound;
an earlier caller deadline applies. The connection's signal retains ownership
after connection and aborts the active channel. Per-send/per-receive deadlines
and signals affect only that operation. A cancelled send that had already entered
the carrier reports `outcome: "unknown"`; the host must query its original
business receipt instead of repeating an action.

Each `send` is one message, at most 64 KiB, and each `receive` returns one message.
Only one receive can be pending. A 256 KiB authenticated credit window limits
unconsumed incoming data and outgoing waiters. Credit includes framing and a
minimum charge for empty/small messages, limiting message count as well as bytes.
Consumers return credit by receiving messages. Full local queues reject with
`resource_exhausted`; callers must await sends and handle backpressure. Browser
WebSocket has no network receive-pause API, so protocol/window violations close
the connection. This bounds Linkspan-owned queues and parser buffers, not the
browser or operating system's own network allocation.

Data, credit, and orderly close records are framed *inside* the established Noise
channel. They are transport lifecycle records, not a replacement host RPC or
multiplexing protocol. `null` is returned only after authenticated orderly EOF;
a relay's socket close, truncation, corruption, or failed close acknowledgement
is an error. `close()` exchanges authenticated close records and releases the
carrier with a bounded timeout; it does not discard data already delivered to
the peer. `abort()` immediately stops local use and releases the carrier.

The release is a self-contained pure JavaScript bundle built through upstream's
browser entry. Node, Web, and React Native use the same security code; the only
runtime package dependency is Linkspan core. No WASM, supplier connector, native
binding, helper, or other OS/CPU artifact is included. The build checks imports
and records its dependency inventory and full licenses. Node's upstream default
AS WASM implementation is deliberately excluded. Hosts must load this module
only for the selected path; a package export alone cannot enforce host loading.

The runtime requires ES2022, `Uint8Array`, `TextEncoder`, `AbortController`,
`Event`, `EventTarget`, a secure `crypto.getRandomValues`, and WebSocket. Hosts
such as Expo/React Native must initialize their secure random source before
importing the module. `Promise.withResolvers` is supplied as a private build
helper without modifying global objects. Availability of the JavaScript bundle
does not establish an actual-device compatibility result.

Trusted HTML/scripts and trusted updates are separate requirements. If a hostile
relay or compromised CA controls the initial application script, it can replace
the verification code; this library cannot make that first load trustworthy.
Hosts must use a trusted installed client, trusted local distribution, or another
independent authenticated loading/update path. The relay can still observe
traffic metadata, delay, limit, or block traffic.

Bundled third-party grants and complete notices remain in the distribution.

The optional `node test/browser-check.mjs` check runs a real browser through an
untrusted forwarding relay and the HTTP adapter. Set `LINKSPAN_BROWSER_DRIVER`
to an installed `playwright-core` entry and `LINKSPAN_BROWSER_EXECUTABLE` to a
compatible browser executable. It checks delayed module loading, actual network
requests, binary upload/download digests, cancellation, endpoint substitution,
and ciphertext tampering; it needs the workspace HTTP package built first.

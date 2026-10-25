# iroh

The independently selected iroh adapter verifies the backend endpoint id and then
authenticates the host's pinned Ed25519 application identity using Linkspan Noise.
It returns the same bounded `VerifiedChannel` used by the HTTP adapter.

Install the lightweight adapter plus only the required runtime: `-iroh-node` for
Node servers/Desktop native hosts, `-iroh-wasm` for Web or an explicitly selected
relay renderer, or the official Swift/Kotlin source binding for a selected mobile
native build. Mobile can also use a bundled trusted WebView for relay mode. Nothing initializes while
displaying connection settings. Native runtime preparation happens at build time;
runtime never downloads an executable. Browser connections use relays only. Public
relay throughput and availability have no SLA. Custom/paid relays require explicit
host configuration; no automatic paid upgrade is performed.

`connectIroh` takes `ticket`, `expectedEndpointId`, `expectedPublicKey`, optional
Noise `identity`, `signal` and `deadline`. `listenIroh` takes a host-owned Noise
identity and optional separately persisted iroh 32-byte `secretKey`. Tickets locate
an endpoint; a changed ticket never replaces either trusted identity.

Restricted/paid relays also require the client's own `clientKey` (64 hex),
`relayUrls`, `relayToken` and `relayTokenExpiresAt`. The token must be a resource
lease scoped to that exact backend identity, never the publisher services secret.
Public and open self-hosted relays need no such lease. The publisher-only
`@jokoagent/linkspan-iroh-services` module mints official signed `relay:use` grants
for 60..86400 seconds. The listener can take `servicesApiSecret` with explicit
relay URLs and `servicesTokenTtlSeconds` (default one hour); it renews its own
short lease while it remains enabled, and closes on renewal failure or expiry.
Client lease expiry closes the original streams. New business authority is still
decided by the host. A per-profile backend identity is reused across concurrent
streams and released after its last stream closes.

Browser relay authentication necessarily uses the upstream WebSocket query-token
mechanism. Treat that short resource lease and the entire authenticated relay URL
as private; never log it. Native relay authentication uses the upgrade header.

Use `createIrohBridgeClient({request})` from `/bridge` to bind each connection to
its own host. Node `/node` and browser `/browser` export independent
`createIrohBridgeHost()` factories. The legacy `installIrohBridge` hook remains
available. Keep this local bridge private, bound to
the current trusted document and disposed when that document closes. It carries
only SDK bytes; the application security handshake and business secrets remain in
the caller's Noise endpoint. Missing runtime assets are a deployment error.

An explicit `relayUrls: []` disables relays and discovery for native UDP; the WASM
runtime rejects this mode instead of selecting a public relay. macOS Intel builds
the exact official N-API source because its upstream prebuilt target is absent.
Its separately selected `mode: 'wasm'` preparation remains relay-only.

`/native-sources` resolves the packaged Swift/Kotlin module sources and protocol
metadata. The module exposes `isAvailable()`, `request(json)` and `dispose()`;
request successes contain `{success:true,value}`, and failures contain only
`{success:false,code}`. Disposal retires current resources; the host can create a
new engine for a later foreground session. Native connections share one backend
endpoint per persisted key and relay configuration, with a separate reference
for every stream. Android requires API24 and a packaged selected ABI. iOS builds
the unmodified fixed SDK source for deployment16.4; the upstream prebuilt
xcframework requires17.5 and is not substituted. Apple compilation/device checks
must be recorded separately from Windows JVM verification of the Kotlin engine.

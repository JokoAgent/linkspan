# tailcat

This optional adapter embeds tailcat 0.7.0's WireGuard data plane without a
Tailscale account, TUN, full-network routing or network-member management. Its
address contains a PSK: exchange it privately and protect it as a credential.
The endpoint's complete `nodekey:<64 lowercase hex>` is pinned independently;
Linkspan then verifies the host's application Ed25519 identity through Noise.

Install only the required `-tailcat-node` or `-tailcat-wasm` runtime. Native
helpers are explicitly prepared for one OS/CPU while building the host, never
downloaded at startup. Web uses the separately built Go WASM runtime and DERP
only. React Native hosts bundle that same WASM runtime inside a trusted local
WebView and use `installTailcatBridge` / `createTailcatBridgeHost`.

`connectTailcat` accepts `address`, `expectedEndpointId`, `port`,
`expectedPublicKey`, optional client backend key, Noise identity and cancellation.
`createTailcatIdentity()` generates a backend key through the selected upstream
binding. Persist its `privateKey` locally and give only `publicKey` to the server
allowlist. The client key is reused across concurrent streams through one SDK
client; closing one stream never closes its siblings. Do not reuse the same
backend client key with different server addresses at the same time.
`listenTailcat` only admits an explicit client allowlist, or explicitly approved
pairing through a privately delivered fresh PSK address. It exposes only its
single application stream listener; arbitrary proxying, shell, files and exit
nodes are never enabled. Host pairing and business authorization remain required.

The listener returns a full address containing the selected DERP node details,
including a configured self-hosted map. Short external addresses can also specify
`derpMapUrl` on the client. Private addresses and backend private keys never belong
in public discovery, logs or ordinary display state.

This is experimental: upstream API/wire compatibility has no stability promise;
public DERP is rate limited, has no SLA and may be withdrawn. Browser direct
connections and mobile background execution are not promised. Missing bindings
are code/deployment errors, separately from missing account/device test evidence.

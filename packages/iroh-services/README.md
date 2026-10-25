# Publisher relay leases

Server-only bounded delegation using fixed official `iroh-services` 1.0.0 caps
and its signature-verifying RCAN implementation. The separate small WASM asset
works in Node; it has no networking, relay client or client-provider login flow.
Only explicit publisher configuration installs this component.

`issueIrohRelayLease({apiSecret,endpointId,ttlSeconds})` grants only `relay:use`
to that recipient's backend public key for 60..86400 seconds (default one hour).
Its returned expiry is the exact signed token expiry. The host rechecks authority
before delivery, saves private recovery receipts and never sends the services
master secret to a client. Per-lease remote revocation is unavailable; stop local
authority immediately and bound outstanding resource use by TTL/provider quotas.

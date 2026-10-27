# localtunnel adapter

Uses fixed localtunnel 2.0.2 for the explicitly selected experimental public HTTP
carrier. The client dials only a dedicated loopback bridge; that bridge verifies
the fixed host HTTPS origin CA/SNI. It never enables invalid-certificate options.
The selected SDK is privately bundled from fixed inputs with a narrow lifetime
patch. Cleanup cancels its pending bootstrap request, clears reconnect timers,
and destroys its own connecting and live sockets. Supplier connection counts and
bootstrap bodies are bounded. Source/output hashes, inventory and MIT notices
ship with the package; startup never modifies an installed dependency.

The public instance has no SLA and may show an anti-abuse page. Requested names
are not guaranteed. Existing client dependencies, actual WSS/file/long-stream
behavior, assigned-name stability and hosted availability require deployment
verification. A self-selected existing compatible service may be configured;
the adapter does not deploy a server or purchase a plan.

# localtunnel adapter

Uses fixed localtunnel 2.0.2 for the explicitly selected experimental public HTTP
carrier. The client dials only a dedicated loopback bridge; that bridge verifies
the fixed host HTTPS origin CA/SNI. It never enables invalid-certificate options.
Cleanup closes its own tunnel object.

The public instance has no SLA and may show an anti-abuse page. Requested names
are not guaranteed. Existing client dependencies, actual WSS/file/long-stream
behavior, assigned-name stability and hosted availability require deployment
verification. A self-selected existing compatible service may be configured;
the adapter does not deploy a server or purchase a plan.

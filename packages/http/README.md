# Linkspan HTTP

Optional streaming HTTP mapping over an already verified Linkspan byte channel.
It carries one request per channel, including concurrent upload/response bodies,
headers, response trailers, cancellation and authenticated completion. It never
retries or follows redirects. It has no dependency on a host's RPC or data model.

`createHttpClient({origin, connect})` supplies the structural universal HTTP client
used by Connect and other streaming consumers. `createHttpFetch({origin, connect})`
supplies the Fetch boundary used by browsers and Expo. `connect` must perform
endpoint pin verification before resolving; plaintext channels are not secure.
Client requests accept core `signal` and absolute `deadline` options. Their
lifetime covers connection, upload and response consumption; expiration aborts
the active channel and local request. A late connection is retired before any
business bytes are sent. Early completed responses cancel a pending upload
without waiting for its producer. HTTP framing failures expose a stable
`protocol_error` with their original cause, without copying payloads into the
public message.

`serveHttp(channel, {origin, authorize})` from the `/node` entry forwards only to
an exact host-configured loopback origin. The peer can choose a relative path,
never a destination host. The host retains request authorization and registers
revocation against the channel in `authorize`. Do not expose the loopback handler
through a public connector. HTTP redirects remain responses for explicit handling.

Metadata is limited to 32 KiB and 128 headers; body records are 16 KiB. Backpressure
comes from the channel's bounded send/receive contract. The host enforces its own
body, route and authorization budgets. Response trailers are populated when the
body iterator finishes. Consumers must read or cancel response bodies.

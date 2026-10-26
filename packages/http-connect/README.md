# @jokoagent/linkspan-http-connect

Optional standard HTTP CONNECT carrier for a host-selected proxy and authority.
The portable root accepts a native `StreamCarrier`; `/node` can dial an explicit
HTTP or HTTPS proxy and can own an accepted Node TCP/TLS socket. This package has
only the neutral core as a runtime dependency. HTTP-only consumers do not install
its private parser.

```ts
import { connectHttpConnectStream } from '@jokoagent/linkspan-http-connect/node';
import { connectStream } from '@jokoagent/linkspan-noise';

const carrier = await connectHttpConnectStream({
  proxyOrigin: 'https://proxy.example', authority: 'application.example:443', signal
});
const channel = await connectStream(carrier, { expectedPublicKey, signal });
```

`negotiateHttpConnect(carrier, {authority, signal, deadline})` writes only a fixed
CONNECT request and Host field, parses bounded HTTP/1.x responses, and returns an
opaque carrier retaining any bytes after the successful response. A 2xx response
does not authenticate the application: verify the independently pinned endpoint
key with Noise before sending business data. No environment proxy, arbitrary
headers, visitor credentials, redirect, retry or transport fallback is used.

Proxy origins must be canonical `http(s)://host[:port]` without credentials, path,
query or fragment. Authority must be canonical lower-case `host:port` or
`[IPv6]:port`. HTTPS authenticates the proxy with the platform trust store and
SNI from connection start; the target carries raw Noise without a TLS upgrade.
Ordinary browsers cannot open raw TCP or issue CONNECT through Fetch. Embedded
mobile/native hosts provide the raw carrier; no additional client software is
required.

Limits are 16 KiB across response headers, 64 fields per response, four interim
responses, 128 KiB per read/write, one pending read and write, and ten seconds for
negotiation and graceful close (an earlier caller deadline wins). The Node socket
adapter retains at most its bounded native buffer and one parser remainder.
Cancellation aborts the original carrier; graceful close waits for accepted
writes and actual native closure without aborting first. Refused, malformed,
truncated or over-limit responses fail and retire their original carrier.

The build verifies the exact `http-parser-js` 0.5.10 source and upstream MIT notice
hashes, embeds its unmodified parser in a private portable module, and distributes
the full upstream notice and input receipt inside `dist`. It adds no Node Buffer
polyfill or runtime parser dependency. Upstream source:
https://github.com/creationix/http-parser-js

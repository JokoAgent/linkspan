# Pinggy adapter

Implements HTTPS, TLS passthrough, TCP and TLSTCP with two explicit runtimes: fixed Pinggy SDK
0.5.3/native 0.3.1 or ssh2 1.17.0. No automatic runtime fallback occurs. The SDK
path requires `preparePinggySdk` during deployment; its upstream native install
script is never run. Preparation copies only fixed JS and the selected target's
hash-verified native files. The published native ABI is 137; other Node/Electron
ABIs can explicitly use SSH with an independently trusted server host-key pin.

Both runtimes forward only to the host's dedicated carrier bridge. TLS and raw TCP require
the certificate-matching public origin and verifies the assigned endpoint. Free
session lifetime is locally limited to 60 minutes. Publisher tokens manage the
tunnel; no visitor auth/debugger is enabled and no plan is bought. Actual free
endpoint allocation, paid account conditions and continuous hosted streams need
deployment testing.

TLSTCP requires `budget.paidEnabled: true` for an existing Pro account and an
explicit `tlstcpEndpoint: "tcp"` or `"tls"`. The TCP endpoint passes the visitor's
host TLS bytes. Pinggy terminates outer TLS at its TLS endpoint, so that selection
uses the fixed HTTP-to-verified-HTTPS bridge and still carries only application
Noise ciphertext. The exact assigned endpoint must match both the chosen scheme
and `publicOrigin`. No Pro subscription, reservation or automatic fallback is
created. [Official tunnel semantics](https://pinggy.io/docs/usages/) and
[SDK/Pro conditions](https://pinggy-io.github.io/sdk-nodejs/).

Public UDP uses `startDatagramMapping` from the central connectors `/datagram`
entry with `provider: "pinggy"`, `runtime: "sdk"` and the prepared `sdkDirectory`.
It retains that entry's packet, peer, traffic, timeout and native capture-owner
boundaries. SSH UDP is unavailable. Omit both public host/port for a free temporary
allocation or supply an exact existing endpoint pair; the result reports the
actual allocated host/port. The SDK resource receipt is recorded synchronously
before `tunnel.start`, and late or unknown creation is never replayed. Real hosted
UDP, allocation quotas and physical media/NAT behavior require deployment testing.

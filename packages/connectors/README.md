# Public carriers

This package starts only the provider selected by the host. Importing the
package, reading `CONNECTOR_LIMITS`, and validating configuration do not install
or start a helper. Official SDK adapters are separate optional packages.

`startConnector(config, options)` takes a dedicated loopback HTTPS carrier,
`originCaPool` containing public CA certificates, a fixed `originServerName`, a
stable host operation `requestId`, cancellation/deadline, and synchronous
`onResource`. It returns `publicOrigin`, the owned `resource`, `closed`, and
`close()`. The host performs application authentication, endpoint-key checking,
encrypted application transport, permissions, and file/media ownership.

Every configuration requires `budget: {paidEnabled, maximumSessionMs,
maximumBytes}`. The local bridge counts both directions and retires the session
when its budget expires. Provider billing and quotas may count differently.
`paidEnabled` records consent to using an existing paid account. These APIs do
not buy plans, register payment methods, deploy new control planes, or promise
that a provider's quota is unlimited. Known paid ngrok TLS endpoints require
`paidEnabled: true`; Pinggy free sessions are capped at 60 minutes locally.

HTTP carriers forward to a private HTTP bridge which verifies the fixed host
HTTPS origin CA/SNI. TCP/TLS carriers forward the visitor's host TLS bytes.
Neither request Host/URL, supplier messages, environment variables nor an
SDK-refreshed port list can choose a different local destination. Visitor
SSO/PIN/password/header authentication is not enabled by these adapters.

## Implemented modes and verification boundaries

Paths below are package-relative unless another package is named. Local relay
tests use the actual fixed binaries and an actual authenticated host TLS server.
Account-free tests establish code behavior; they do not establish hosted service
availability, regional quotas, throughput, device behavior, or account access.

| Mode | Source entry | Selected verification | Remaining hosted prerequisites |
| --- | --- | --- | --- |
| Cloudflare Quick | `../cloudflare/src/index.ts`, `startQuickTunnel` | Restricted-helper source/build checks; origin/cancellation tests in that package | Free endpoint allocation, anti-abuse and Internet/stream behavior |
| Cloudflare named | `../cloudflare/src/named.ts` and `startNamedTunnel` | API uncertainty/ownership tests; restricted local ingress | Publisher account/API token, owned DNS name/CNAME, real tunnel provisioning |
| Funnel HTTP / TLS-terminated TCP | `src/helpers.ts`, `helpers/funnel/main.go`, tsnet v1.104.2 | Actual helper build; TLS-terminated raw listener forwards fixed byte target; serve-state Go tests | Tailnet key, MagicDNS/HTTPS/Funnel policy, allowed ts.net name and port |
| Funnel raw TCP carrying host TLS | Same entry with `mode: "tcp"` | Actual helper build; raw ServeConfig and nonpersistent serve-state tests | Same tailnet conditions; no UDP support is implied |
| frp public TCP | `src/helpers.ts`, frpc v0.71.1 | Actual client/server TLS transport and host TLS relay test | Existing frps operator, public TCP port and certificate |
| frp public HTTP vhost | Same, `mode: "http"` | Actual vhost relay to the fixed CA/SNI-verified host HTTPS bridge | Existing public HTTPS frontend terminating outer TLS before frps HTTP vhost; application Noise is still required |
| frp public HTTPS | Same, `mode: "https"` | Actual SNI HTTPS-vhost client/server relay test | Existing frps HTTPS vhost/domain, certificate |
| frp public UDP mapping | `src/datagram.ts`, same fixed frpc | Actual authenticated client/server UDP relay, binary packet bounds and owned cleanup | Existing frps UDP port; matching client/server `udpPacketSize`; same-host authorized native media target |
| rathole TCP over Noise | Same, rathole v0.5.0 | Actual local relay, fixed Noise key, host TLS test | Existing server/service/token and reachable public listener |
| rathole TCP over TLS | Same, explicit CA/relay hostname | Actual verified connector TLS and host TLS test | Existing server certificate/PKCS12 identity and public listener |
| rathole UDP over Noise | `src/datagram.ts`, same fixed rathole | Actual service `type: "udp"`, fixed relay Noise key, binary packets and cancellation/cleanup | Existing UDP service/token/public port and same-host authorized native media target |
| rathole UDP over TLS | Same, explicit CA/relay hostname | Actual verified TLS relay, binary packets and cancellation/cleanup | Existing relay PKCS12 identity, matching CA/SNI and owned native media target |
| bore TCP carrying host TLS | Same, bore v0.6.0 | Actual local bore relay with host TLS, secret configuration | Existing server or bore.pub fixed available port, certificate for public host; no SLA |
| SSH reverse TCP carrying host TLS | `../ssh/src/index.ts`, ssh2 1.17.0 | Actual ssh2 server, pinned host key, reverse bind, host TLS, cleanup | SSH account/key, trusted SSH fingerprint and GatewayPorts/public bind policy |
| NetBird public HTTP | `src/netbird.ts`, `helpers/netbird/main.go`, embed v0.81.4 | Resource ownership/error tests, fixed peer target, helper build, unsafe persisted capability rejection | Publisher management token/setup key, dedicated peer and proxy-enabled cluster |
| NetBird TLS passthrough | Same, mode `tls` and raw TLS bridge | Resource protocol/allocated public port tests; helper build | Cluster mode/port availability, certificate matching public endpoint |
| NetBird TCP carrying host TLS | Same, mode `tcp` | Same L4 port/identity tests and fixed listener | Cluster raw TCP availability and host certificate |
| NetBird UDP packet mapping | `src/datagram.ts`, embed `ListenUDP`, `helpers/common/packet.go` | Real UDP echo, peer separation, packet bounds, idle/budget/cleanup tests; helper build | Actual public UDP proxy and same-host authorized native media target |
| ngrok HTTP | `../ngrok/src/index.ts`, SDK 1.7.0 | Config rejection and shared origin/lifecycle tests | Publisher account/token, free domain/traffic/request quotas and warning-page behavior |
| ngrok TLS passthrough | Same, mode `tls` | Paid-consent guard, fixed host origin, SDK adapter build | Existing paid TLS/domain feature, certificate matching assigned endpoint |
| ngrok TCP carrying host TLS | Same, mode `tcp` | Exact assigned endpoint validation and SDK adapter build | TCP account/card verification or paid reservation; exact public port/certificate |
| zrok public | `helpers/zrok/main.go`, fixed v2.0.8 Go SDK | Actual SDK helper build, bounded REST, exact-owner cleanup tests | Enabled dedicated environment/account, public frontend, free quota/interstitial behavior |
| zrok reserved hostname | Same; `mode: "reserved"`, `reservedToken: "namespace:name"` | Same SDK resource lifecycle; fixed name-selection branch | User-owned name/namespace and fixed v2 service compatibility; no private access client |
| Pangolin public HTTP | `helpers/pangolin/main.go`, fixed Newt 1.19.0 | Actual restricted helper build; remote capability/target rejection tests | Existing dedicated site/HTTP resource at Cloud or selected deployment |
| Pangolin raw TCP carrying host TLS | Same; `mode: "tcp"` | Exclusive TCP target filter and host raw TLS bridge | Existing raw resource and owned remote node where Cloud requires one, host certificate |
| Pangolin UDP packet mapping | `src/datagram.ts`, selected Newt UDP proxy | Actual restricted helper build; exclusive UDP filter, global peer/message limits; local UDP tests | Existing raw UDP resource, owned remote node and same-host native media target |
| Pinggy HTTPS, SDK runtime | `../pinggy/src/index.ts`, SDK 0.5.3/native 0.3.1 | Selected archive/JS/native hashes; actual Windows Node ABI 137 load | Actual free/paid tunnel, temporary hostname and interstitial/stream behavior |
| Pinggy TLS passthrough, SDK runtime | Same, mode `tls` | Exact reported origin and prepared ABI checks | Matching host certificate and actual service TLS-mode access |
| Pinggy raw TCP, SDK runtime | Same, mode `tcp` | Fixed raw TLS bridge; exact assigned `tcp://` endpoint and selected SDK fixtures | Matching host certificate, actual free/random or reserved TCP port |
| Pinggy TLSTCP, SDK runtime | Same, mode `tlstcp`, `tlstcpEndpoint: "tcp"` or `"tls"` | Paid-consent guard and separate exact-scheme endpoint/bridge checks | Existing Pro account; TCP arm passes host TLS, TLS arm terminates outer TLS at Pinggy and retains application Noise |
| Pinggy HTTPS, explicit SSH runtime | `../pinggy/src/ssh.ts`, ssh2 1.17.0 | Explicit selection/host-pin guard; shared fixed-origin tests | Independently verified Pinggy host fingerprint and actual service connection |
| Pinggy TLS passthrough, explicit SSH runtime | Same, mode `tls` | Host-pin and exact endpoint validation | Same SSH trust plus matching host certificate; Electron may select this runtime explicitly |
| Pinggy TCP / both TLSTCP endpoints, explicit SSH runtime | Same, modes `tcp` / `tlstcp` and explicit `tlstcpEndpoint` | Shared endpoint/bridge selection, trusted SSH pin and no automatic runtime fallback | Actual service access; TLSTCP requires an explicitly enabled existing Pro plan |
| Pinggy public UDP mapping, SDK runtime | `src/datagram.ts`, `../pinggy/src/datagram.ts` | Selected SDK forwarding/endpoint fixtures, real bounded UDP bridge, original journal/cancellation/late-owner tests | Prepared ABI-compatible SDK and actual free temporary or reserved UDP allocation; SSH UDP is unavailable |
| Dev Tunnels anonymous HTTP/WSS | `../dev-tunnels/src/index.ts`, SDKs 1.3.61 | Real typed SDK REST adapter tests: stable ID, anonymous AC, GET-only material recovery and exact cleanup | Publisher account, cluster, service anti-phishing/body/stream limits and real relay connection |
| localtunnel HTTP/WSS | `../localtunnel/src/index.ts`, SDK 2.0.2 | Config rejection and shared origin/lifecycle tests | Public instance availability, anti-abuse page, assigned hostname and actual long streams |

`CONNECTOR_LIMITS` exposes Beta/experimental/free/session/body-limit notes to
host settings and console UIs. Free and experimental entries are implemented
paths with explicit conditions; they are not evidence of unrestricted service.

The mode boundary follows actual client requirements. Full private-network/TUN
membership, Cloudflare Access/WARP, supplier visitor SSO/OAuth/PIN/password/header
authentication, frp STCP/SUDP/XTCP visitors and zrok private TCP/UDP shares are
excluded: those private paths require a separately installed network/access
client. Zrok public/reserved HTTP forwarding remains included. Pinggy UDP uses
the SDK because SSH has no UDP forwarding; selecting SSH never silently installs
or switches to the native SDK. Bore and reverse SSH expose TCP only. The Funnel
HTTP path already uses a TLS-terminated `net.Listener` and byte forwarding, so
the upstream TLS-terminated-TCP carrier has the same selected path. Static file
servers, raw terminal/database services and arbitrary local targets are host
applications, not extra Linkspan modes.

Official mode evidence: [frp TCP/UDP](https://gofrp.org/en/docs/features/tcp-udp/),
[frp vhosts](https://gofrp.org/en/docs/features/http-https/),
[rathole v0.5.0 service type](https://github.com/rathole-org/rathole/tree/v0.5.0),
[Pinggy tunnel types](https://pinggy.io/docs/usages/),
[Pinggy SDK and Pro TLSTCP](https://pinggy-io.github.io/sdk-nodejs/),
[Funnel options](https://tailscale.com/docs/reference/tailscale-cli/funnel),
and [zrok share modes](https://netfoundry.io/docs/zrok/category/guides/).

## Explicit helper preparation

Use `prepareConnectorHelper({provider,directory,target?,goExecutable?,
cargoExecutable?,rustcExecutable?,signal?})` during a host-controlled deployment
step. Persist the returned absolute executable, target, version and SHA256 in
private deployment configuration. Startup only checks that prepared artifact.
The supported desktop/server target names are `win32-x64`, `win32-arm64`,
`linux-x64`, `linux-arm64`, `darwin-x64`, and `darwin-arm64`.

Official archives and extracted executables are pinned independently. Missing
official rathole/bore platform binaries use a fixed original-source build,
including a fixed rathole build-metadata lock compatibility patch. Linux ARM64
rathole also uses that source build with explicit TLS and Noise features:
the upstream v0.5.0 ARM release omits TLS ([upstream build inputs](https://github.com/rathole-org/rathole/blob/v0.5.0/.github/workflows/release.yml)). Zrok always
uses the small fixed SDK helper rather than distributing the administrative UI
or general CLI. Funnel, NetBird and Pangolin helpers use pinned Go 1.27.3 source
inputs and emit `helper-build.json` plus preserved upstream notices. Rust source
fallbacks additionally require the selected Rust target and its native linker.
On Linux, rathole's TLS source build also needs `pkg-config` and OpenSSL
development files; the deployed target needs the compatible OpenSSL runtime.
Preparing one provider does not build the other providers or download all
targets. Target compilation does not count as running on that device.

Separate SDK packages are `@jokoagent/linkspan-ngrok`, `linkspan-ssh`,
`linkspan-pinggy`, `linkspan-dev-tunnels`, and `linkspan-localtunnel` under the
same `@jokoagent` scope. Pinggy requires explicit `preparePinggySdk`; its upstream
native install script is never enabled. Its native SDK runtime requires Node ABI
137. Other ABIs can explicitly choose the SSH implementation with a trusted
server fingerprint; no automatic fallback occurs.

## Resources and recovery

The host persists an operation and credentials before effects. Cloudflare named,
NetBird public proxy, and Dev Tunnels resource APIs implement create/find/delete.
`find` without an exact prior receipt returns `createdByHost: false`; names and
labels never confer cleanup ownership. `expectedResource` performs exact-ID
lookup and cannot create a replacement if the original is missing. Dev Tunnels
`getDevTunnelMaterial` is an exact-ID GET-only host-token refresh.

Dispatched writes with timeouts, ambiguous HTTP results, malformed/oversized
responses or lost replies remain `outcome_unknown`. A host can explicitly adopt
an independently queried exact candidate only under its original operation and
user authorization. No provider token or endpoint private key belongs in a
public resource handle.

`reconcileConnectorResource` closes a live same-process owner or reports whether
a transient listener's original process is absent. It never kills a PID from a
journal. Zrok public shares are persistent provider effects: their exact share
ID plus original environment identity is recorded as resource refinement before
readiness. Reconciliation uses that exact SDK lookup/cleanup and reports retired
only after confirmation. Missing handles, different owners, failed cleanup and
unknown replies stay unknown. `closed` and `close()` reject unconfirmed zrok
cleanup, including when the process already exited.

NetBird `targetPort` and runtime `listenPort` identify the peer-side userspace
listener. Resource API `listenPort` and returned resource `listenPort` identify
the separate public proxy port. They must not be confused. Dedicated peer state
must be host-owned. The helper rejects persisted or MDM-applied SSH/jobs/metrics,
unrestricted routes/LAN, or a changed management URL before joining the network.

## UDP use by a native media host

The `/datagram` entry exports `startDatagramMapping`. It accepts a literal
locally owned `localTarget: {address,port,ownerId}` and returns a separate
`mapping: {protocol:"udp", publicHost,publicPort, localAddress,localPort,
ownerId,requestId,expiresAt}` with `resource`, `closed`, and `close()`. It is not
an HTTPS origin, ByteChannel or TURN server. The host must own the native media
socket/candidate, preserve DTLS-SRTP/SDP identity verification, and revoke the
mapping with the exact media attempt or capture permission.

Browser/WebView sockets and media on a different machine cannot be redirected
merely by embedding an overlay. Those cases keep their normal ICE/TURN path.
Packet limits default to 2048 bytes, 32 peers and 30 seconds idle, with hard maxima
65507 bytes, 64 peers and 120 seconds. Queues and both-direction traffic are
bounded; excess packets are dropped without concatenation or retry.

frp defaults to 1500 bytes instead, matching its upstream `udpPacketSize`. An
explicit `maximumDatagramBytes` is written to the fixed frpc configuration; the
frps operator must use the same value. rathole maps an existing UDP service over
verified Noise or TLS and never publishes a plaintext connector-to-relay leg.
Pinggy accepts `runtime: "sdk"` and the prepared `sdkDirectory`. Omit both
`publicHost` and `publicPort` for a free temporary allocation; the returned mapping
uses the actual assigned UDP endpoint. If either field is specified, both must
be supplied and must match the assigned endpoint. A configured mismatch retires
the original tunnel instead of adopting a replacement. Free Pinggy sessions are
capped locally at 60 minutes; no subscription or persistent reservation is bought.

## Checks

`pnpm test` runs account-free runtime, UDP, resource and lifecycle tests.
`LINKSPAN_HELPER_RELEASE_TESTS=1` additionally runs all nine actual local relay
cases in `test/helper-relays.test.mjs`; those are explicitly skipped otherwise.
Go tests for common/Funnel/NetBird verify fixed targets, packet behavior and safe
embedded state. Pangolin and zrok preparation also runs their restricted-source
tests. Hosted account/device/NAT checks remain separate from these code checks.

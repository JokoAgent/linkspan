# Node WebRTC engine

`createNodeWebRtcPeer` supplies the platform peer API for the separately selected
`@jokoagent/linkspan-webrtc` data-channel adapter. It uses `werift@0.25.2`
(MIT, source `6a6d0daaeddc01eef24069849deccd7e4389666a`) on Node 22 or newer.
The browser adapter and core package do not install this engine. Its fixed
dependencies are bundled with their inventory and full license texts. This keeps
the engine's certificate schema registry independent from a host's ASN.1 versions.
There are no native binaries, downloads on startup, device permissions, or capture.

The host exchanges bounded SDP over its existing authenticated, pinned signaling
channel and passes the received SHA-256 fingerprint to `openWebRtcChannel`.
Both peers must verify the actual DTLS certificate before sending application
data. Configuration does not create trust. The host also owns ICE/TURN credentials,
request cancellation, peer closure, business authorization and revocation.

`setLocalDescription` gathers ICE before resolving. This package preserves the
platform API used by Linkspan, including binary ArrayBuffer data events and actual
remote certificate inspection. No other backend is loaded or selected on failure.
An explicit empty ICE list or TURN-only list does not activate a default public
STUN service. Explicit STUN/TURN selection remains under the host's control.

The fixed engine has a minimal build-time lifecycle patch: a stream reset waits
for its queued DATA to receive the original SCTP acknowledgments, and completion
is reported after both directions finish their existing reset/acknowledgment
paths. This prevents closing the owned peer while the remote HTTP consumer
still has authenticated records to read. The original
wire protocol and error handling remain in place. `dist/upstream-patches.json`
records the exact upstream input and patched output hashes; a changed input
fails the build. Real browser checks cover slow consumers, HTTP error responses,
large uploads/downloads, truncated responses, transport abort and cancellation.

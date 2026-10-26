# WebRTC data channel

`openWebRtcChannel` adapts one host-created, reliable ordered RTCDataChannel.
The host supplies a SHA-256 DTLS certificate fingerprint obtained through trusted
signaling. The adapter waits for the platform DTLS handshake and checks the actual
remote certificate before exposing the byte channel. It never trusts a fingerprint
discovered from an unauthenticated peer. Application authorization remains separate.

Messages are at most 65,535 bytes; send buffering defaults to 512 KiB and receive
buffering to 8 MiB/1024 messages. One send and one receive may be pending. Cancellation
retires this channel; it does not replay effects. Closing a channel leaves shared
media and other channels running unless the host explicitly transfers ownership.
Graceful closure drains queued bytes and waits for the SCTP stream reset before
closing an owned peer; cancellation aborts immediately. Closure has a ten-second
bound, so an unresponsive peer cannot keep resources indefinitely.

The host owns ICE, SDP exchange, TURN materials and media permissions. This package
contains no WebRTC engine, TURN SDK, signaling server, WASM or native binary. Browser
and native bridges must provide the platform WebRTC API including inspection of the
actual remote DTLS certificate; unsupported engines fail closed. Real NAT, blocked
UDP, background operation and hardware still require their corresponding devices.

Node hosts can explicitly install `@jokoagent/linkspan-webrtc-node` and load
`createNodeWebRtcPeer` when selecting this path. Browser-only consumers do not
install the Node engine or its dependencies.

# Linkspan core

`@jokoagent/linkspan-core@0.1.0` provides `ByteChannel`, `OperationOptions`,
`LinkspanError`, and disposable cancellation/deadline lifetimes. It has no runtime
dependencies, transport, supplier SDK, WASM, database, or host business model.

Deadlines are absolute milliseconds. A successful `send` acknowledges local
transport acceptance. Hosts retain business receipts, idempotency, trust decisions,
authorization, persistence, and recovery. Cancellation of a wait cannot undo a
remote effect. Channel ownership includes closing or aborting it and observing
`closed`. Exactly one `receive` may be pending; transport modules document their
message and buffer limits. `null` means orderly EOF, and failures are reported as
stable error codes. Error causes are for trusted debugging and must not be logged
with credentials or application contents.


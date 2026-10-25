# Pinggy adapter

Implements HTTPS and TLS passthrough with two explicit runtimes: fixed Pinggy SDK
0.5.3/native 0.3.1 or ssh2 1.17.0. No automatic runtime fallback occurs. The SDK
path requires `preparePinggySdk` during deployment; its upstream native install
script is never run. Preparation copies only fixed JS and the selected target's
hash-verified native files. The published native ABI is 137; other Node/Electron
ABIs can explicitly use SSH with an independently trusted server host-key pin.

Both runtimes forward only to the host's dedicated carrier bridge. TLS requires
the certificate-matching public origin and verifies the assigned endpoint. Free
session lifetime is locally limited to 60 minutes. Publisher tokens manage the
tunnel; no visitor auth/debugger is enabled and no plan is bought. Actual free
endpoint allocation, paid account conditions and continuous hosted streams need
deployment testing.

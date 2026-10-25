# Cloudflared input

The connector prepares **2026.10.3-linkspan.1**, a restricted build of cloudflared
**2026.10.3**, annotated tag `d15abb83ccb896641191bac95717805305d7d56e`, source commit
`de6376c5af4a67cbc65258682e5a01781827643d`. It is a modified build, and is not an
official Cloudflare release executable.

- Source and dependency versions: <https://github.com/cloudflare/cloudflared/tree/2026.10.3>
- Fixed source archive: <https://codeload.github.com/cloudflare/cloudflared/tar.gz/de6376c5af4a67cbc65258682e5a01781827643d>
- Source license: Apache-2.0, reproduced without changes in `LICENSE.cloudflared`.
- Service terms and privacy: <https://www.cloudflare.com/terms/> and
  <https://www.cloudflare.com/privacypolicy/>. Source licensing does not grant a
  service availability guarantee or remove the service terms.

The source archive is 651992 bytes, SHA-256
`6c6901ae333508e1c529184bf90cb87ff59592620d293401db38415269908311`.
The accompanying `cloudflared-restricted.patch` has SHA-256
`91ffa0b07efbc3d53426d8e3e9dd0f336869365cc64af3bfeb0a8dffa026eb82`.
It rejects edge-supplied ingress configuration and arbitrary TCP destinations
before the actual HTTP/2 handler dispatches them. It also rejects internal
management routes before the origin proxy dispatches them; disabling only
`management-diagnostics` would still expose logs and host details to platform
management tokens. The wrapper forces `http2`,
which has no protocol fallback and excludes the QUIC/UDP session entry points.
Ordinary HTTP/WSS still uses the fixed HTTPS origin and its fixed CA/server name.
Local cloudflared credentials or a fixed startup config alone do not provide
this boundary: the original binary also accepts remote ingress replacement and
TCP destinations. Original binaries are rejected even as executable overrides.

`scripts/build-restricted-helper.mjs` performs explicit build preparation with
Go **1.27.3**, CGO disabled, readonly module resolution, `-trimpath`, no VCS
injection, an empty build ID, and a fixed version/build timestamp. The Windows
toolchain used for the recorded local builds is the official
`go1.27.3.windows-amd64.zip`, SHA-256
`f26081f438319757f8a1b46d7d0b2c5ec7583d4038e485e0aa725cfde7885fff`, from
<https://go.dev/dl/>. Go verifies dependency archives against the fixed source's
`go.sum`. The manifest pins each target executable's size and SHA-256; a build
must match it before use. Runtime startup never builds or downloads code.

The preparation check exercises forged configuration/TCP internal headers
against the actual patched edge handler and checks that neither reaches an
origin dispatcher; HTTP/WSS still dispatches normally. All six targets were
cross-built on Windows; other operating systems still require their own runtime
checks before a host claims support. Windows arm64 is a verified source cross-build;
its runtime behavior still requires an arm64 device or runner.

This package contains no helper executable and no install script. Hosts that
redistribute a prepared helper must retain its source/license materials.
`THIRD_PARTY_NOTICES.cloudflared.md` preserves 98 license/notice files from the
70 modules actually linked across the six pinned restricted targets and the Go standard
library license. `cloudflared.build-inputs.json` records exact module identities,
replacement modules, embedded Go content checksums and collected notice hashes.
The maintenance generator checks every module archive against the content
checksum embedded in the actual binary before collecting its notices. These
are source/license materials, not installed Go SDKs or executable payloads.

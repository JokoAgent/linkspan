# Connector runtime

Shared typed provider configuration, `CONNECTOR_LIMITS`, fixed local-origin
bridges, budget/cancellation ownership, and resource reconciliation primitives.
No SDK, provider process or download is started by importing this package.

The default entry exposes metadata and types. The `/runtime` entry supplies
fixed-target HTTP-to-verified-HTTPS and raw TLS bridges used by provider adapters.
Only the explicitly selected frp tcpmux mode may use a dedicated raw Noise
literal-loopback target without origin HTTPS credentials. All other modes still
require their fixed HTTPS endpoint, public CA and SNI and reject raw targets.
Its resource reconciliation never terminates a process using a saved PID.
Persistent provider resources require their provider-specific exact receipt and
cleanup API. Hosts should use the central connectors entry for complete zrok
reconciliation rather than the transient primitive.

The host supplies a dedicated encrypted carrier endpoint, fixed public CA/SNI,
original operation identity, explicit traffic/time/paid consent and synchronous
resource recording. Application permissions and authorization remain with the
host. See the connectors README for modes and verification boundaries.

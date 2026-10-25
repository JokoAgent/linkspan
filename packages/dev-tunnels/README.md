# Anonymous Dev Tunnels adapter

Uses fixed Microsoft connections/management/contracts SDKs 1.3.61. The optional
package contains the anonymous HTTP/WSS carrier and typed create/find/delete
resource operations. SDK HTTP is restricted to service HTTPS endpoints with
bounded responses/timeouts, redirects disabled and diagnostic/event reporting
disabled. The forwarding subclass accepts only the approved single port and
fixed local carrier bridge.

`createDevTunnel` uses the original operation's stable explicit tunnel ID with
conditional create. Find-only name/label matches are unowned candidates.
`expectedResource` cannot create replacements. `getDevTunnelMaterial` performs
only exact-ID GETs to recover host material for the original owned tunnel.
Deletion checks exact cluster/ID/port/label and anonymous connect access at both
tunnel and port. Unknown writes are not replayed under a new ID.

Publisher credentials and host access tokens stay private to the host vault;
visitors receive no account requirement from this adapter. The hosted service
is a development/Beta path with anti-phishing pages, quotas and HTTP body limits.
Actual account/relay availability and long WSS/file streams need deployment
testing; unit checks do not establish their throughput or limits.

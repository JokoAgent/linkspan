# SSH reverse adapter

Uses fixed ssh2 1.17.0 to create one exact remote TCP bind and forward it to the
dedicated host TLS bridge. An independently trusted SHA256 SSH host-key pin is
required before publisher authentication. Supply an existing SSH account and
server GatewayPorts policy that permits the chosen public bind.

The adapter enables no shell, agent forwarding, TUN or arbitrary local routes.
It bounds active streams and closes only its own forwarding client. An actual
local ssh2 server test checks host TLS, SSH pin rejection, exact remote port and
owned cleanup. Internet reachability and remote SSH policy remain deployment
prerequisites.

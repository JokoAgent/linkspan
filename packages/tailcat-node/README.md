# tailcat Node runtime

This package contains the bounded JSON pipe binding and a reproducible helper
build, not a binary. Explicitly prepare the required target during application
packaging using `prepareTailcatRuntime({directory,target,goExecutable})`, then stage
the directory and call `configureTailcatRuntime(absoluteDirectory)`. Runtime only
verifies and starts that packaged helper. It never builds or downloads code.

The helper imports published `github.com/tailscale/tailcat v0.7.0` with fixed
go.mod/go.sum, requires Go 1.27.3 and CGO-disabled target builds. No shell, files,
SSH service, proxy, exit-node or TUN is exposed. Commands and replies travel over
the host's private pipes; raw provider diagnostics are not published. The host
owns listener and connection shutdown. Public DERP connectivity and mobile
background behavior require separate environment validation.

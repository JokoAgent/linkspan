# Bundled security implementation

This module wraps `@libp2p/noise@17.0.7`, upstream commit
`d41cc9fdd9b92596246deba0d4b8ad0078adfc69`, licensed under Apache-2.0 OR MIT.
Registry integrity:
`sha512-PSqVKlx919Wh+D+VC/y0amUu8t6qCUZmZlzeeTdLszxDOzOOQjZ9Wievzh/b/N5vQIRI9iXEqzhWpn2QFfFvNg==`.

The artifact bundles its browser crypto implementation and the exact dependency
versions recorded in the repository lockfile. `dist/dependency-inventory.json`
lists the inputs in the delivered artifact. Full upstream license/notice texts
are retained in `dist/THIRD_PARTY_LICENSES.txt`; esbuild's linked legal comments
are retained alongside the bundle.

Some upstream tarballs omit their license files. `licenses/sources.json` pins
the exact official source commit for each recovered MIT license; their verified
identical text is preserved in `licenses/upstream-MIT.txt`. Builds use these
checked-in texts, require an explicit entry for each omitted file, and perform no
network license lookup. The MIT option is selected for those dual-licensed inputs.

Official sources:

- [Registry release](https://registry.npmjs.org/@libp2p%2Fnoise/17.0.7)
- [Fixed upstream source](https://github.com/libp2p/js-libp2p/tree/d41cc9fdd9b92596246deba0d4b8ad0078adfc69/packages/connection-encrypter-noise)
- [libp2p Noise protocol](https://github.com/libp2p/specs/blob/master/noise/README.md)

No formal audit of this complete Linkspan integration is asserted. The protocol,
the maintained handshake implementation, and its cryptographic dependencies are
separate inputs. In particular, an audit of a primitive is not an audit of this
adapter or the host's trust/bootstrap/update channel.

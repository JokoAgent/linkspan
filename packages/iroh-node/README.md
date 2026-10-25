# iroh Node runtime

This package is a thin loader and build preparer, with no native binary and no
install script. Explicitly call `prepareIrohRuntime({directory,target})` from the
`/prepare` entry during packaging, then stage that one target directory and call
`configureIrohRuntime(absoluteDirectory)` before using the iroh adapter. Startup
verifies its receipt and bytes, and never downloads code. A shared npm tarball
works across CI platforms; the staged application contains only its own target.

The preparer pins official `@number0/iroh` 1.2.0 platform archives by SHA-512.
Windows x64/arm64, macOS arm64 and Linux x64/arm64 glibc/musl are available.
The `darwin-x64` preparer builds the fixed official `number0_iroh` N-API source
with Rust/Cargo1.99 and Xcode, preserving native UDP. Select `mode: 'wasm'`
explicitly to copy the independently built relay-only WASM runtime instead.
There is no runtime download.
The exact upstream source commit and archive inputs are in upstream.json, and
THIRD_PARTY_NOTICES.txt preserves the fixed source's selected dependency graph.

Publisher services support explicitly installs the independent
`@jokoagent/linkspan-iroh-services` signing component. A service master credential
stays in the publisher. Client connections receive only an endpoint-scoped
resource lease; simultaneous connections share one SDK endpoint identity.

The `/prepare-mobile` entry exports
`prepareIrohMobileRuntime({directory,platform,targets,cacheDirectory?,signal?})`.
Android ABI targets are `arm64-v8a`, `armeabi-v7a`, `x86_64`, and `x86`; only those
selected are staged, and API JARs exclude upstream desktop natives. iOS targets
are `ios-arm64`, `ios-simulator-arm64`, and `ios-simulator-x64`; macOS/Xcode plus
Rust1.99 target standard libraries build the unmodified official source for
iOS16.4, using the exact official FFI headers. Native outputs include upstream
license texts, dependency inventory, target list, source hashes and byte receipts.
Existing outputs are verified before reuse; changed selections require a fresh
build-owned output directory. The package itself contains no `.node` or `.so`.
The Android binding pairs JNA5.19.1 Java classes with its matching JNI library;
the SDK's older declared JNA has Android16KB compatibility defects. Preparation
checks each ELF ABI, 64-bit load-segment alignment and the SDK JNI initialization
entry before staging. This build check is distinct from a real16KB device run.

In the source workspace,
`pnpm --filter @jokoagent/linkspan-iroh-node test:native-kotlin` requires JDK21 and
explicitly prepares fixed validation inputs. It runs actual SDK UDP, identity
rejection, binary reads/writes, concurrent reference ownership, cancellation and
disposal/recreation checks. This JVM check does not prove Android JNI/device
behavior or Apple compilation.
For installed validation tooling, the fixture source directory is resolved from
the application's installed `@jokoagent/linkspan-iroh/native-sources` marker.
It may also be supplied explicitly as `sourceDirectory` using that marker's
containing directory; the validation command is not an application startup path.

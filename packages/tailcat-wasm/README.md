# tailcat WASM runtime

This independent browser artifact contains the fixed tailcat 0.7.0 Go/WASM
binding and its matching Go 1.27.3 runtime. Build preparation writes
`dist/runtime/tailcat.wasm`, `wasm_exec.js` and its integrity receipt. It contains
no native executable or other platform binaries.
Using the already prepared browser artifact requires no Node builder. To rebuild
through `/prepare`, explicitly install the matching optional
`@jokoagent/linkspan-tailcat-node` build peer and fixed Go1.27.3. The build-only
package contains source and preparation code; it does not add a native executable
to the selected browser runtime.

The application loads it only when choosing tailcat. Normal Web loading uses the
fixed, module-relative WASM asset; trusted native WebViews may first supply their
bundled bytes through `configureTailcatWasm(bytes)`. All browser traffic uses DERP
relays, with no direct UDP or full-network routing. The private address's PSK is
never a public endpoint identifier or a substitute for application authorization.

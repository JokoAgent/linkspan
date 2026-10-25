# iroh WASM runtime

This separately selected browser runtime binds fixed iroh core 1.4.1 through
wasm-bindgen 0.2.112. Its build script prepares `dist/runtime/linkspan_iroh.js`
and `linkspan_iroh_bg.wasm`. Only load this module when the user selects iroh.
Browser transport is relay-only, with the same authenticated endpoint identity
and application Noise verification as native clients. It does not install a VPN.

Normal Web loading uses the fixed module-relative WASM asset. A trusted native
WebView host can first call `configureIrohWasm(bytes)` with its bundled bytes,
then start the adapter bridge without a `file://` fetch. Arbitrary remote module
URLs and provider-supplied replacement code are not accepted.

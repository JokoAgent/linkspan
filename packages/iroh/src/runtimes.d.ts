declare module "@jokoagent/linkspan-iroh-node" { export function createIrohRuntime(): Promise<import("./types.js").IrohRuntime>; }
declare module "@jokoagent/linkspan-iroh-wasm" { export function createIrohRuntime(): Promise<import("./types.js").IrohRuntime>; export function configureIrohWasm(bytes: Uint8Array): void; }

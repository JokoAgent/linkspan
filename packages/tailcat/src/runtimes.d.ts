declare module "@jokoagent/linkspan-tailcat-node" { export function createTailcatRuntime(): Promise<import("./types.js").TailcatRuntime>; }
declare module "@jokoagent/linkspan-tailcat-wasm" { export function createTailcatRuntime(): Promise<import("./types.js").TailcatRuntime>; export function configureTailcatWasm(bytes: Uint8Array): void; }

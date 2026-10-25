import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export async function prepareTailcatWasm(options = {}) {
  let prepareTailcatRuntime;
  try { ({prepareTailcatRuntime}=await import("@jokoagent/linkspan-tailcat-node/prepare")); }
  catch(cause){throw new Error("Rebuilding the selected tailcat WASM requires the explicitly installed, matching optional @jokoagent/linkspan-tailcat-node build package.",{cause});}
  return prepareTailcatRuntime({ ...options, directory: options.directory ?? fileURLToPath(new URL("../dist/runtime", import.meta.url)), target: "browser-wasm" });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify((await prepareTailcatWasm()).receipt));

import { dirname,join } from "node:path";
export function rustBuildEnvironment({cargoExecutable,clangExecutable}) {
  const rustc=cargoExecutable.replace(/cargo(?:\.exe)?$/u,process.platform==="win32"?"rustc.exe":"rustc");
  const environment={...process.env,RUSTC:rustc,RUSTFLAGS:"",CARGO_BUILD_RUSTFLAGS:"",CARGO_ENCODED_RUSTFLAGS:"",CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUSTFLAGS:"",RUSTC_WRAPPER:"",RUSTC_WORKSPACE_WRAPPER:"",CARGO_INCREMENTAL:"0",CC_wasm32_unknown_unknown:clangExecutable,AR_wasm32_unknown_unknown:join(dirname(clangExecutable),process.platform==="win32"?"llvm-ar.exe":"llvm-ar"),CFLAGS:"",TARGET_CFLAGS:"",CFLAGS_wasm32_unknown_unknown:"",CARGO_PROFILE_RELEASE_OPT_LEVEL:"s",CARGO_PROFILE_RELEASE_LTO:"true",CARGO_PROFILE_RELEASE_CODEGEN_UNITS:"1",CARGO_PROFILE_RELEASE_PANIC:"abort",CARGO_PROFILE_RELEASE_STRIP:"true",CARGO_PROFILE_RELEASE_DEBUG:"0"};
  delete environment.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER;
  return environment;
}

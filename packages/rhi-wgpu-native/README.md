# forgeax-rhi-wgpu-native

Private Rust native-wgpu owner for ForgeaX desktop hosts. The first consumer is
`apps/native-ray-query-triangle-tauri`, which proves native Metal or Vulkan Ray Query from a
packaged Tauri application.

## Boundary

The crate owns the native wgpu instance, adapter, device, queue, surface, acceleration structures,
Ray Query passes, readback, and structured failures. Consumers provide an owned raw-window-handle
source and call the narrow `RayQueryRenderer` lifecycle. They never receive a raw wgpu object.

This spike API is intentionally not a complete native RHI. A public TypeScript capability or
BLAS/TLAS vocabulary waits until a TypeScript-to-native command consumer exists.

## Commands

```sh
cargo test --manifest-path packages/rhi-wgpu-native/Cargo.toml
cargo check --manifest-path packages/rhi-wgpu-native/Cargo.toml
cargo run --release --manifest-path packages/rhi-wgpu-native/Cargo.toml --features conformance --bin ray-query-conformance -- --profile core
```

The implementation is pinned to wgpu `30.0.0` because Ray Query is experimental.
The crate compiles only Metal on macOS and only Vulkan on Windows/Linux; both lanes share the same
renderer, acceleration structures, shaders, readback, and verifier.

The non-default `conformance` feature owns the shared Metal/Vulkan case registry, structured GPU
observations, CPU oracle, report schema, stability profiles, and importers for packaged Tauri and
pinned upstream evidence. It remains outside the desktop product binary.

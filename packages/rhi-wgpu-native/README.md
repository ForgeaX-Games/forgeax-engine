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

The implementation uses the Engine-pinned `third_party/wgpu` source, initially
the unmodified wgpu `30.0.1` release. Contributor setup and SDK source delivery are
defined in [third-party source](../../third_party/README.md).
The crate compiles only Metal on macOS and only Vulkan on Windows/Linux; both lanes share the same
renderer, acceleration structures, shaders, readback, and verifier.

The non-default `conformance` feature owns the shared Metal/Vulkan case registry, structured GPU
observations, CPU oracle, report schema, stability profiles, and importers for packaged Tauri and
pinned upstream evidence. It remains outside the desktop product binary.

## Opaque scene reference transport

The opt-in `reference` feature adds `reference::run_batch` and the `ray-reference`
stdin/stdout executable. It consumes the u32 words of the portable reference's
world-space triangle and ray buffers (80/48 bytes per record), creates a fresh
native device and opaque BLAS/TLAS, and returns 32-byte hit records plus adapter
facts. Limits are 1,024 instances, 65,536 triangles and 65,536 rays; malformed
records fail before GPU creation. An empty triangle list is supported.

This is a scene-level bridge for differential validation. It admits no BLAS build
transforms, dynamic query flags or custom candidate filtering, and claims no fix
for the pinned wgpu issues. It neither implements a generic native TypeScript RHI
nor records native AS commands in `.rhitape`. Keep it outside default production
and browser compilation; the portable shader requires no native WGSL extension.
See [reproduction and layouts](../../scripts/raytracing/README.md).

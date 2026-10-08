# forgeax-rhi-wgpu-native

Private Rust native-wgpu owner for ForgeaX desktop hosts. The first consumer is
`apps/native-ray-query-triangle-tauri`, which proves native Metal or Vulkan Ray Query from a
packaged Tauri application.

## Boundary

The crate owns the native wgpu instance, adapter, device, queue, surface, acceleration structures,
Ray Query passes, readback, and structured failures. Consumers provide an owned raw-window-handle
source and call the narrow `RayQueryRenderer` lifecycle. They never receive a raw wgpu object.

This spike API is intentionally not a complete native RHI. The public TypeScript capability and
BLAS/TLAS vocabulary live in `@forgeax/engine-rhi` (§Hardware Ray Query); the crate-private
`acceleration` module mirrors it in Rust: `RayQueryCaps::from_device` derives `caps.rayQuery`
from device features and limits, `create_blas` / `create_tlas` /
`build_acceleration_structures` apply the same structural rules and lower to wgpu by field
rename. The `reference` transport builds its BLAS/TLAS through that module. The Node binding
(§Node binding) is the TypeScript consumer: a Renderer created over it in Node derives
`caps.rayQuery.supported === true` from the real adapter, so the automatic `ray-query` world
traversal runs on a GPU device, not only on RhiNull and this crate's parity tests.

Its GPU test traces an indexed two-instance scene (masks, scale, translation) from a compute
`ray_query` shader and compares hit, custom index, primitive index, and `t` with a CPU
Moller-Trumbore oracle, then refits moved geometry and instances on the same handles. It skips
without a Ray Query adapter unless `FORGEAX_REQUIRE_NATIVE_RAY_QUERY=1`. Mesa lavapipe 25.2
exposes `VK_KHR_ray_query`, so CPU Vulkan runs it:
`cargo test --manifest-path packages/rhi-wgpu-native/Cargo.toml --features reference acceleration`
with that ICD selected.
wgpu 30 accepts `refit` (`ALLOW_UPDATE` + `PreferUpdate`) but still performs a full build.

The test-only `world_traversal_parity` module runs the render package's generated
world-trace kernels (`src/__tests__/fixtures/world-traversal/*.wgsl`, kept equal to
`worldTraversalWgsl` by `world-traversal.unit.test.ts`) on one scene through both
traversals. It composes the Global SDF with the production compose kernel, builds
BLAS/TLAS through `acceleration`, and checks: the `ray-query` fixtures validate only with
`Capabilities::RAY_QUERY`; Ray Query hits equal a CPU slab oracle exactly (status,
instance, `|dt| <= 1e-4 max(t,1)`, normal, Card radiance) for 1024 rays; the Global SDF
stays within stated tolerances (all hit, plane distance <= 1 voxel for >= 95 %,
`|dt|` <= 2 voxels for >= 95 %, radiance equal for >= 97 %); and a 0.02-thick wall
leaks no Ray Query ray while a masked-out wall leaks every admitted ray (falsifier):
`FORGEAX_REQUIRE_NATIVE_RAY_QUERY=1 cargo test --manifest-path packages/rhi-wgpu-native/Cargo.toml world_traversal -- --nocapture`
with the lavapipe 25.2 ICD selected.

## Node binding (napi-rs)

`@forgeax/engine-rhi-wgpu-native` (this directory's `package.json`, TypeScript in `src/*.ts`)
gives Node a TypeScript RHI device over native wgpu 30.0.1 (Vulkan on Linux/Windows, Metal on
macOS) with the Ray Query extension. The Rust half is the `cdylib` crate `node/` (napi-rs v3).

Why this crate and not an existing device:

| Candidate | Measured fact | Result |
|:--|:--|:--|
| Dawn-node `webgpu@0.4.0` | On Mesa 25.2.8 Lavapipe (which exposes `VK_KHR_ray_query` to wgpu here) the adapter reports 17 features, 0 named ray or acceleration | No Ray Query feature to request; Dawn reports `backend-has-no-ray-query` |
| `@forgeax/engine-wgpu-wasm` | wgpu 29, `default-features = false`, `webgl` only | No native backend in the WASM build |
| This crate | wgpu 30.0.1 Vulkan/Metal; BLAS/TLAS, compute Ray Query and the world-traversal kernels pass here | Only native owner with the capability |

Shape. The addon does not grow a second RHI. `src/gpu.ts` + `src/encoder.ts` are a
W3C-WebGPU-shaped `GPU` (adapter, device, queue, resources, encoders, error scopes,
`uncapturederror`, `lost`) whose calls lower to the addon. `rhi` is the existing
`@forgeax/engine-rhi-webgpu` shim with adapters requested from that `GPU`, so validation,
error mapping, render-graph lowering and RHI Debug recording are the same code as the
browser and Dawn paths. An earlier design had a TypeScript shell implement `RhiDevice`
directly. That design was rejected: it would duplicate the rhi-webgpu shim, and the Dawn
test roster could not run unchanged over it.

- Objects cross as numeric table ids. A `FinalizationRegistry` drops collected entries, and
  `destroy()` drops them eagerly. Id 0 is the invalid object of a failed creation; its error
  already went through the device's error scopes.
- Descriptors cross as JSON.
- Command encoders and render bundles record in TypeScript and replay in one N-API call per
  `finish()`, so there are no per-draw crossings.
- `queue.submit` takes the finished ids.
- `mapAsync` and `onSubmittedWorkDone` resolve after a device poll.
- Uncaptured errors and device loss are drained on `setImmediate` after each mutating call.
- GPU objects serialize to `{}` like W3C objects, because RHI Debug snapshots descriptors
  with `JSON.stringify`.
- Ray Query is the wgpu extension shape that `@forgeax/engine-rhi-webgpu`'s
  `WebGpuAccelerationStructures` consumes:
  - device `createBlas` / `createTlas`, plus encoder `buildAccelerationStructures`;
  - the feature `wgpu-ray-query` (`RAY_QUERY_FEATURE`) and the four `RhiRayQueryLimits`
    limit names;
  - `caps.rayQuery` derived by `deriveRayQueryCaps`.

  The Renderer's device-feature admission requests that feature when the adapter offers it.
  On Metal, wgpu-hal places no barrier between an acceleration-structure build and a later
  traversal, and TLAS instances reference their BLAS outside Metal's hazard tracking. A
  consumer that builds and traverses in back-to-back submissions must settle the build
  (`onSubmittedWorkDone`) first; RHI Debug replay does this for every bootstrap rebuild.
  It is also the replay provider for ray-query tapes (`FORGEAX_WEBGPU_NODE=wgpu-native`).
- `executeBundles([])` executes one empty bundle of the pass layout. WebGPU resets pass
  state on every `executeBundles`; wgpu's empty list does not.
- `timestampPeriod` is exposed because wgpu does not normalize resolved timestamps.
  Raw counter integrity must be checked on the actual adapter. On the tested
  Apple M4 Pro/macOS 26.4.1, the original 30.0.1 Metal resolve returned zero or
  stale values even with actual GPU work. The Engine-pinned repair reserves
  sampling/resolve/continuation order and resolves after sampling completion.
  Empty or indirectly dispatched timestamped compute encoders without a nonzero
  direct dispatch use one side-effect-free kernel to materialize sample boundaries;
  its work is observer overhead, not free feature execution. The native owner
  regression verifies fresh raw pairs, attachment bytes, multiple resolves and
  one-row copies with omitted stride and nonzero offsets. Preserve failed raw
  values and reject qualification rather than substituting CPU time. The upstream
  investigation is [wgpu #9414](https://github.com/gfx-rs/wgpu/issues/9414).
  Render counters span
  vertex-stage start to fragment-stage end, while compute counters use encoder
  boundaries; attachment load/clear, resolve and store coverage is separate.
- Offscreen only: there is no canvas context or surface.

Delivery and failure. The addon is an opt-in local build. Nothing in `pnpm build:engine`, the
public SDK build or the default test roster compiles or requires it, and no `.node` binary
is committed (`native/` and `node/target/` are gitignored). Without the binary, every entry
returns `adapter-unavailable`, never a throw: `createGpu`, `installNavigatorGpu` and
`rhi.requestAdapter`. `nativeWgpuVersion()` returns `null`.

```sh
pnpm --filter @forgeax/engine-rhi-wgpu-native build:native   # cargo build --release -> native/*.node
```

| Environment variable | Effect |
|:--|:--|
| `FORGEAX_WEBGPU_NODE=wgpu-native` | `config/vitest.setup-webgpu.ts` and `apps/hello/gi/scripts/gi-dawn.mjs` install this `GPU` as `navigator.gpu` instead of Dawn, so `*.dawn.test.ts` and the hello-gi scripts run unchanged on it. A missing addon fails setup with `wgpu-native-binding-failed`. |
| `FORGEAX_WGPU_NATIVE_RAY_QUERY=off` | Withholds `wgpu-ray-query` from the adapter. The same device then runs the Global SDF traversal for A/B comparison. |
| `FORGEAX_RHI_WGPU_NATIVE_ADDON=<path>` | Load the addon from `<path>` instead of `native/forgeax-rhi-wgpu-native.<platform>-<arch>.node`. |

Example run under Lavapipe (Mesa 25.2.8, Vulkan llvmpipe):

```sh
FORGEAX_WEBGPU_NODE=wgpu-native with-lavapipe pnpm exec vitest run --project @forgeax/engine-rhi-webgpu <file>.dawn.test.ts
FORGEAX_WEBGPU_NODE=wgpu-native with-lavapipe node apps/hello/gi/scripts/smoke-dawn.mjs
```

Known differences from Dawn are listed below. Each is visible as data, never as a crash:

- Dawn-specific live probes (`rgba16float-live-probe`,
  `rhi-wgpu dawn-texture-dimensions`) report their gate as unavailable.
- There is no presentation surface.

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

# hello-triangle

ECS-driven smoke harness — `apps/hello/triangle/scripts/smoke-dawn.mjs` shares
the same `world.spawn(5 component) → await renderer.ready → renderer.draw(world)`
path as `apps/hello/triangle/src/main.ts` and `apps/hello/cube/scripts/smoke-dawn.mjs`
(feat-20260510-smoke-architecture-redesign cash-out of
`feat-future-hello-triangle-ecs-smoke`; the previously-inline `TRIANGLE_WGSL`
parallel implementation is gone). Charter proposition 6 ("simulation coverage
≠ real usability") guarded by `apps/hello/triangle/scripts/smoke-coverage-gate.mjs`
(δ shared-symbol grep + ζ stderr structural assertion). See AGENTS.md §verify
GPU smoke gate "hello-triangle vs hello-cube smoke 角色分工".

## Onboarding (AI users start here)

### Three-command SSOT

| Command | Role |
|:--|:--|
| `pnpm --filter @forgeax/hello-triangle smoke` | dawn-node 直跑 (800x600 BGRA8 offscreen render target + 300-frame loop + GPUBuffer copyTextureToBuffer + mapAsync three-coordinate sample; three-part verdict: backend=webgpu / frames >= 300 / pixel readback ε-threshold; K-1 amend C-ii bypasses chromium WebGPU + lavapipe entirely) |
| `pnpm test:browser` | vitest browser project (RHI/engine API integration layer; chromium chrome-beta channel + WebGPU launch flags) |
| `pnpm test:dawn` | vitest dawn project (real GPU command record + queue.submit; dawn.node native binding; ubuntu-latest must not skip) |

### ENV knobs

Default values are byte-for-byte identical to the
`DEFAULTS` Object.freeze block in
`apps/hello/triangle/scripts/smoke-criteria.mjs:62-67`, and to the same
table in `packages/engine/README.md` §验证闸门 (mirrored view, single
source of truth — architecture principle #1). These ENVs are tuning
knobs, **not bypass switches** (K-10 立场: no manual override).

| ENV | 默认 | 含义 |
|:--|:--|:--|
| `SMOKE_DURATION_MS` | `5000` | smoke 运行时长 (AC-11; 缩到 5s 让 PR 反馈快) |
| `SMOKE_MIN_FRAMES` | `300` | raf 帧累计下限 (K-5 + AC-03 (b)) |
| `SMOKE_PIXEL_THRESHOLD` | `0.05` | pixel readback ε-threshold (K-5 baseline; 超过 0.1 视为放宽超阈值) |

### FAIL stderr three segments

When `pnpm --filter @forgeax/hello-triangle smoke` exits non-zero,
`apps/hello/triangle/scripts/smoke-dawn.mjs` emits a **structured
three-segment payload** at every `process.exit(1)` site (7 paths total:
dawn.node import / `create([])` / `requestAdapter` / `requestDevice` /
`createShaderModule` / `mapAsync` / `verdict.pass=false`). AI users
consume this payload directly — the segments are documented contract,
not free-form text (charter 命题 4 显式失败 + 命题 3 机读结构).

| 段 | 含义 |
|:--|:--|
| `[smoke] FAIL - <reason>` | reason: 失败原因摘要 (e.g. `dawn-node create([]) failed: ...`, `gpu.requestAdapter() returned null`, `triangle-center pixel ... ≈ clearColor`) |
| `  rerun: <command>` | rerun: 复现命令 (verdict.pass=false 路径会建议 `SMOKE_DURATION_MS=10000 pnpm --filter @forgeax/hello-triangle smoke` 双倍时长重试) |
| `  hint:  <recovery>` | hint: 平台 / 驱动 / 缓存层面的恢复建议 (e.g. macOS Gatekeeper xattr cleanup, linux libvulkan1 + mesa-vulkan-drivers, plan-strategy K-1 amend C-ii) |

### SSOT (3 sources, byte-for-byte identical)

The smoke invocation literal `pnpm --filter @forgeax/hello-triangle smoke` lives
in **three** places — kept byte-for-byte identical (architecture
principle #1 SSOT; verified by
`apps/hello/triangle/scripts/ac-08-grep-gate.mjs`):

- `.github/workflows/ci.yml` (CI smoke step).
- `apps/hello/triangle/package.json#forgeax.smokeInvocation`.
- `.claude/skills/forgeax-step-verify/SKILL.md` §Iron Law 9.

> Note: hello-triangle has **3 sources** (the Iron Law 9 entry was
> introduced for the verify-gpu-smoke-gate batch); `apps/hello/cube`
> has **2 sources** (each app owns its own smoke invocation; D-S10).
> Counts differ on purpose — see `apps/hello/cube/README.md` §SSOT
> for the 2-source mirror.

### hello-triangle vs hello-cube ROLE

Both `apps/hello/triangle/scripts/smoke-dawn.mjs` and
`apps/hello/cube/scripts/smoke-dawn.mjs` are **ECS-driven smoke harnesses**
(`world.spawn(5 component) → await renderer.ready → renderer.draw(world)`
全链路 GPU 验证) sharing the `evaluateSmokeCriteria` SSOT pure function and
the K-12 pixel ε=0.05 baseline (feat-20260510-smoke-architecture-redesign
cash-out: the previously-inline `TRIANGLE_WGSL` parallel implementation
in hello-triangle is gone). The two harnesses now differ only in geometry
fixture: hello-triangle uses `HANDLE_TRIANGLE` (3 vertices, +Z facing
normal) while hello-cube uses `HANDLE_CUBE` (8 vertices, 36 indices). The
ROLE split is recorded in AGENTS.md §verify GPU smoke gate "hello-triangle
vs hello-cube smoke 角色分工".

## Shader composition (T-19 canonical demo)

The PBR shader is split into 3 files under `src/shaders/` as a canonical
demonstration of naga_oil composition via `#import` (feat-20260512-naga-oil-
composition-hmr):

- `view.wgsl` — `#define_import_path hello_triangle::view`; declares the
  shared `View` + `Mesh` structs + `@group(0)` + `@group(2)` bindings.
- `brdf.wgsl` — `#define_import_path hello_triangle::brdf`; declares the
  Cook-Torrance helpers `f_schlick` / `v_smith` / `d_ggx`.
- `pbr.wgsl` — root shader; pulls the above via `#import`.

`pbr.wgsl` header:

```wgsl
#import hello_triangle::view::{View, Mesh, view, meshes}
#import hello_triangle::brdf::{f_schlick, v_smith, d_ggx}

struct Material { baseColor : vec3<f32>, metallic : f32, roughness : f32 };
@group(1) @binding(0) var<uniform> material : Material;
// ... vs_main / fs_main using view / meshes / f_schlick / v_smith / d_ggx
```

`src/main.ts` pre-flight `compileShader` call (AC-13 / AC-14 type-inference
application point):

```ts
import { compileShader } from '@forgeax/engine-shader-compiler';
import pbrSrc from './shaders/pbr.wgsl?raw';
import viewSrc from './shaders/view.wgsl?raw';
import brdfSrc from './shaders/brdf.wgsl?raw';

await compileShader(pbrSrc, {
  id: 'hello_triangle::pbr::main',
  imports: {
    'hello_triangle::view': viewSrc,
    'hello_triangle::brdf': brdfSrc,
  },
});
```

The Vite plugin (`@forgeax/engine-vite-plugin-shader`) transparently runs
the same pipeline during `vite build` for the three input roots declared in
`vite.config.ts#build.rollupOptions.input` and propagates cross-file HMR
(edit `view.wgsl` - the plugin's `reverseDeps` map reloads `pbr.wgsl`
through `handleHotUpdate`; T-15 / T-16).

For the full smoke-gate context (K-7..K-12 stances, three-command
contract, post-merge-monitor.yml), see
[AGENTS.md §verify GPU smoke gate](../../AGENTS.md#verify-gpu-smoke-gatefeat-20260508-verify-gpu-smoke-gate--feat-20260509-lavapipe-mapasync-lifecycle-k-1-amend-c-ii).


# State projection cost measurements

## Feature signature admission

`render-feature-signature.bench.ts` measures the native feature host's
`recordPlanSignature` followed by the graph's
`renderFeaturePlanSignatureEvidenceMatches`. Its synthetic fixture has 18 named
emitters, each declaring a 64 KiB WGSL program, three buffers, one binding set and
one dispatch. Descriptor validation and the initial canonical signature run
before timing. Each benchmark alternates two prebuilt plan objects; equal
uploads must retain the signature, while capacity/dispatch or shader changes
must advance it on every iteration. Graph evidence must match after every step.

The same fixture ran before and after immutable-string token reuse, on Linux
x86_64 / Node 24.19.0 / Vitest 4.1.11, with 200 ms warm-up and 1,000 ms sampling
per case. Baseline source is `148ef3f2ff4954584ecc44d5f8027a1a33951e62`.
[Recorded statistics](feature-signature-results.json) preserve each sample count
and relative margin of error.

| Timed host + graph check | Before mean (ms) | After mean (ms) | Before p99 (ms) | After p99 (ms) |
|:--|--:|--:|--:|--:|
| Buffer uploads only | 3.161 | 0.108 | 4.108 | 0.192 |
| One buffer capacity and dispatch change | 3.193 | 0.129 | 3.826 | 0.231 |
| One shader source change | 3.433 | 0.358 | 4.779 | 0.612 |

These are signature CPU measurements, not full-frame FPS or GPU timings. The
fixture does not compile or execute the synthetic shader. Plan construction,
GPU resource preparation, graph recompilation and resource retirement are
outside the measured interval and retain their existing behavior.

```sh
node node_modules/vitest/vitest.mjs bench --run \
  --config packages/render/vitest.config.ts \
  packages/render/bench/render-feature-signature.bench.ts \
  --maxWorkers=1 --outputJson /tmp/feature-signature-result.json
```

## State projection

Render Bundle submission has a separate [changing-workload report](render-bundle-evidence/README.md)
with two complete 17-case runs, raw samples, RHI Debug failure evidence, and explicit
stable/changing workload tradeoffs. Its [carrier](render-bundle-stress.ts) measures
CPU command submission rather than full-frame FPS.

The comparison runs identical workloads against two source revisions. Production
changes use one current-state projection; the sequential extractor exists only
as a lower-bound measurement and does not include persistent topology or GPU work.

| Carrier | Workload contract | Records |
|:--|:--|:--|
| Node | 60 warm-up + 180 measured frames; 64 / 2,048 entities | Simulation, projection and total CPU median/p95, scanned rows, process heap peak |
| Chromium WebGPU | 30 warm-up + 90 measured frames; 32 / 512 entities | Simulation, draw CPU, submit CPU, submission-completion latency, buffer-write calls/bytes and raw samples |

Both carriers cover small, static, contiguous sparse, scattered, dense,
fragmented-table, historical-empty-table, parent-transform and shared-material
workloads. The Node carrier additionally runs the sequential extractor.
Material changes use the old shared-ref protocol only when measuring a revision
that predates managed content. Node asserts equivalent material output.

```sh
node scripts/bench/run-state-projection.mjs /path/to/baseline /tmp/projection-baseline
node scripts/bench/run-state-projection.mjs . /tmp/projection-candidate
node scripts/bench/run-state-projection-browser.mjs /path/to/baseline /tmp/browser-baseline
node scripts/bench/run-state-projection-browser.mjs . /tmp/browser-candidate
```

The baseline needs installed dependencies and the usual checked WASM payloads.
The browser carrier uses this checkout's browser fixture/compiler preparation and
aliases runtime packages to the requested revision's source. Run the normal
browser shader preparation first. Its temporary test uses a separate Vite cache
and is excluded from the normal browser roster by filename.
Raw browser results are written through a Vitest Browser command into
`result.json`; console forwarding is not the artifact transport. A successful
test process without that file remains a failed measurement.

> [!IMPORTANT]
> Compare matching workloads on the same device. The fixed diagnostic budgets
> are baseline p95 × 1.20 + 0.2 ms for Node total CPU, and baseline p95 × 1.20 +
> 2 ms for browser draw CPU / completion latency. Preserve failed and contended
> runs. Passing one pair on a loaded machine does not establish an improvement.

Submission completion is a fence observation, not a GPU timestamp or a browser
presentation timestamp. These carriers do not measure DOM input latency, a
separate Render Worker, or SAB transport. Heap peak is not allocated bytes or GC
pause time; use a CPU/heap profile to investigate those costs. The browser
functional gate separately checks two consumers, material and mesh changes,
input-array isolation, rebind, removal, and visible restoration.

## Scene/material scaling

These diagnostics run the real Renderer on native Dawn. Serialize physical GPU
measurements against other workloads on the host. On a shared machine, pass
one case id after the scaling output or after the workload suite (for example
`visibility hzb-10000-high`) and release the EX lock between cases; the shadow
carrier accepts `shadow-stable` after its output path. Build the Engine and shared
shader inputs first; all raw samples, inspections and images stay in `artifacts/`.

```sh
node packages/render/bench/scene-material-scaling.mjs artifacts/scene-material-scaling/scale
node packages/render/bench/scene-material-workloads.mjs artifacts/scene-material-scaling/lod lod
node packages/render/bench/scene-material-workloads.mjs artifacts/scene-material-scaling/visibility visibility
node packages/render/bench/scene-material-workloads.mjs artifacts/scene-material-scaling/decals decals
node packages/render/bench/scene-material-workloads.mjs artifacts/scene-material-scaling/captures capture
pnpm exec tsup --config packages/render/bench/scene-material-shadow.config.ts
node artifacts/scene-material-scaling/shadow-bin/scene-material-shadow.js
```

| Carrier | Control and boundary |
|:--|:--|
| Scaling | Direct / automatic geometry, 1k / 10k rigid and mixed, stable / 1% dirty / full churn; build `hello-custom-shader` first for the real cooked custom program |
| LOD | Hard / crossfade at both sides of the threshold, 1k rigid meshes; direct fallback keeps hard selection |
| Visibility | HZB off / on, high / low occlusion, immediate camera jumps |
| Decals | Zero / active channel opacity, 1 / 16 / 64 volumes, local / near-plane coverage |
| Captures | Planar cadence 4 / 1, cube repeat controls, steady / continuous probes and budget overflow |
| Shadow | Existing pool explicitly invalidated / ordinary reuse; 100% static, 99% static + 1% movable, and 100% movable; Deferred SSAO toggle validates same-extent graph replacement |

Each uses 16 warm frames (bounded capture/filter startup extends this), four ABBA
groups, eight measured frames per window and one unmeasured transition frame.
CPU World/draw and completion wait are separate; GPU time is the measured-pass envelope from the existing
`summarizeGpuPassTimingIntervals` owner, never a sum of overlapping intervals or
a native outer query. Raw ticks and per-view coverage are retained; incomplete
GPU observations block these diagnostic runs. Resource facts cover graph generations and GPU lane allocations;
they do not claim total native/driver residency. Light casting uses the actual
light components; the removed profile shadow flag never disabled these writers.
The shadow control includes explicit invalidation cost and does not expose a
second production cache switch. `FORGEAX_SCALE_PROFILE=1` retains a bounded CPU
profile separately; overflowed captures cannot establish full-run attribution.

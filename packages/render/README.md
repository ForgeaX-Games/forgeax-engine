# `@forgeax/engine-render`

## Particle feature boundary

Particle rendering is provided by
[`@forgeax/engine-vfx-render`](../vfx-render/README.md). This package owns the
generic RenderFeature host, prepared graphics resolver, pipeline readiness
contract, and structured renderer errors; it does not own VFX simulation or
particle asset authoring.

> [!IMPORTANT]
> Render consumes the effective MaterialAsset snapshot produced by extract. Each texture slot carries its own coordinate set and transform into the built-in PBR binding layout; render records do not reinterpret authoring fields or manufacture shader artifacts. The effective `passes` are already validated.

## MaterialAsset render contract

The effective `passes` are validated before the render snapshot is produced.

The render path is `MaterialAsset` -> extract snapshot -> prepare resources -> record the per-slot `coordinates` and values. The effective `parent` is already resolved before extract. If a material contract or reflection binding fails, preserve the structured error and repair the source contract or cooked module before drawing again; that is the recovery route. The render package owns consumption, not material import or cook policy.

> [!IMPORTANT]
> Owner: render vocabulary and the extract → prepare → record frame boundary. Runtime selects concrete services and calls this package; it does not re-own these tokens.

```ts
import { Camera, MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';

const renderer = await createRenderer(canvas);
const ready = await renderer.ready;
if (ready.ok) renderer.draw([world], { owner: 0 });
```

| This package owns | Excluded concepts |
|:--|:--|
| Camera/light/mesh vocabulary, `Renderer`, render errors, documented pipeline operations | Backend selection, asset import, ECS scheduling, animation playback, optional text/tile/sprite authoring |

The stable surface is [`src/index.ts`](src/index.ts). `RenderError` is closed and carries actionable detail. Runtime alone owns host assembly and its `EngineEnvironmentError` rejection contract; render's construction seam is internal to that dependency path.

## Optional CPU profiling

Render accepts the host-owned `Profiler` capability through App assembly. It writes bounded CPU
phase evidence only while a capture is active; it does not add GPU timestamps, ECS spans, a UI, or
a remote method. The artifact and its owner-declared catalog are documented by
[`@forgeax/engine-profiler`](../profiler/README.md).

```ts
import { createProfiler, type Profiler } from '@forgeax/engine-profiler';
import { createRenderer } from '@forgeax/engine-runtime';

const profiler: Profiler = createProfiler();
const renderer = await createRenderer(canvas, { profiler });
```

Use the package's `validateProfileCapture` and `buildProfileModel` entries for offline analysis.
The render package remains the owner of render vocabulary and extract/prepare/record execution.

## RenderFeature: the producer seam

Register one producer-owned feature at the renderer assembly boundary. The
same `FrameData` type flows through `extract`, `prepare`, and `contribute`;
the host supplies ordering, capability projection, graph composition, and
lifecycle isolation.
Both paths execute inside the active RenderGraph and the frame's single
execute/submit boundary.

```ts
import { ok } from '@forgeax/engine-types';
import type { RenderFeature } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';

type FrameData = { readonly visibleCount: number };
const feature = {
  identity: 'package.feature',
  extract: ({ owner }) => ok<FrameData>({ visibleCount: owner }),
  prepare: (data) => {
    void data.visibleCount;
    return ok(undefined);
  },
  contribute: (data, context) => {
    if (data.visibleCount === 0) return ok(undefined);
    context.staging.addResource('color', {
      kind: 'texture',
      lifetime: 'transient',
    }).unwrap();
    context.staging.addPass('named-pass', {
      reads: [],
      writes: ['color'],
      execute: ({ pass }) => {
        void pass;
      },
    }).unwrap();
    return ok(undefined);
  },
} satisfies RenderFeature<FrameData>;

const renderer = await createRenderer(canvas, { features: [feature] });
const ready = await renderer.ready;
if (ready.ok) renderer.draw([world], { owner: 0 });
```

### Five render terms

| Term | Meaning | Owner |
|:--|:--|:--|
| `RenderFeature` | Producer-owned extract/prepare/contribute callbacks and frame data | Feature producer |
| `RenderPipeline` | Full frame policy selected or switched by the host | Render host |
| RenderGraph pass | One declared graph execution node contributed to the active pipeline | Graph host |
| Material pass | One shader-facing pass in a `MaterialAsset` | Material asset |
| Prepared graphics | Opaque pipeline, binding, vertex/index, and attachment references prepared by the host | Render host |

Feature contexts never expose raw GPU graphics state, a complete pipeline
context, submit authority, or a command encoder. They expose an immutable
`Readonly<RhiCaps>` capability snapshot for capability-gated preparation. The
graph-only `addPass`
surface still exposes only named pass and frame identity; use the prepared
graphics surface below when a feature needs pipelines, bindings, vertex/index
data, attachments, and draw records. Both paths execute inside the active
RenderGraph and the frame's single execute/submit boundary. The active RenderGraph
owns that frame boundary. Do not cast either context to a raw device or encoder. See
[`features/graph-contribution.ts`](src/features/graph-contribution.ts) for the
staging shape.

The copyable recipe above is therefore a graph-only Wave 1 feature; it stops at
the graph seam and does not provide a production particle draw path.

### Prepared graphics recipe

Prepared graphics extends the existing graph-owned staging seam with five
opaque reference kinds. A producer requests preparation during `prepare`,
retains only the returned references, and contributes declarative records. The
render host owns generation checks, graph composition, recording, and submit.

```ts
import { ok } from '@forgeax/engine-types';
import type { RenderFeature } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
import type { ParticleRenderBatch } from '@forgeax/engine-vfx';

const batch: ParticleRenderBatch = { batches: [] };
const feature = {
  identity: 'package.prepared-feature',
  extract: () => ok(batch),
  prepare: (_data, context) => {
    const pipeline = context.graphics.preparePipeline('package.pipeline', {
      shader: 'package.shader',
      vertexLayout: 'package.vertices',
      colorFormats: ['rgba8unorm-srgb'],
    });
    if (!pipeline.ok) return pipeline;
    void pipeline.value;
    return ok(undefined);
  },
  contribute: () => ok(undefined),
} satisfies RenderFeature<ParticleRenderBatch>;

const renderer = await createRenderer(canvas, { features: [feature] });
```

This recipe proves public type reachability and host preparation only. It does
not add a visible particle draw path, simulation, VFX production adapter, or
particle demo. `ParticleRenderBatch` remains a producer-owned VFX value; the
render package accepts generic prepared graphics declarations.

### Failure and recovery

`RenderError` is a closed union. Switch on `error.code`, then read
`error.expected`, `error.hint`, and the code-specific `error.detail`.

Feature capability checks are based on `Readonly<RhiCaps>`, and recovery actions
consume the structured `error.detail` context.

| Diagnostic state or code | Recovery action |
|:--|:--|
| `active` | Continue the next frame |
| `failed` / `render-feature-stage-failed` | Correct producer data and retry on the next frame |
| `disabled` / `render-feature-capability-missing` | Provide the capability on a replacement device; after device-loss recovery call `await renderer.recover()`. On a live renderer, `recover()` returns `recover-not-needed`, so rebuild on a capable device instead. |
| `render-feature-registration-conflict` | Fix identity/order at registration |
| `render-feature-pass-order-conflict` | Reorder the declared dependency and retry contribution |
| `render-feature-preparation-failed` | Repair the named prepared resource and retry on the action in `error.detail.recovery` |
| `render-feature-prepared-state-mismatch` | Read the discriminated `error.detail.reason`, repair the generation/layout/format mismatch, and retry |
| `render-feature-draw-recording-failed` | Read `error.detail.backendReason`, then retry after the host reports renderer recovery |
| `disposed` | Terminal; create a new renderer/feature registration |

Use `renderer.renderFeatureDiagnostics()` for a read-only snapshot. Call
`renderer.dispose()` once or repeatedly; disposal is idempotent. A pipeline
switch keeps the feature registration list and rebuilds the active graph.
The host still uses `renderer.registerPipeline(id, pipeline)` for a full
pipeline change.

For the complete declaration shape, read
[`features/types.ts`](src/features/types.ts) and
[`features/prepared-graphics.ts`](src/features/prepared-graphics.ts). For graph
contribution details, read [`features/graph-contribution.ts`](src/features/graph-contribution.ts);
for pipeline switching, read [`renderer.ts`](src/renderer.ts). The producer
asset contract is [`@forgeax/engine-vfx`](../vfx/README.md), while graph
ownership is [`@forgeax/engine-render-graph`](../render-graph/README.md).

> [!WARNING]
> Wave 2 delivered this generic prepared public seam. A downstream Wave 3 VFX
> integration owns visible particle draws; render must not gain a
> particle-kind switch or VFX production dependency. See the
> [VFX Wave 3 handoff](https://github.com/ForgeaX-Games/forgeax-engine-harness/blob/main/docs/vfx-particle-runtime-design.md).

Dynamic consumers use the same boundary explicitly:

```ts
const { Camera, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
```

`@forgeax/engine-runtime` remains the host assembly entry for `createRenderer` and backend policy. Import `Materials` from this package. Runtime is not a compatibility barrel for render components.

Optional text, tilemap, and sprite authoring is intentionally isolated from the
base vocabulary:

```ts
import {
  GlyphText,
  SpriteAnimation,
  Tilemap,
  setTransparentSortConfig,
  TRANSPARENT_SORT_MODE_LAYER_Y,
} from '@forgeax/engine-render/authoring';
```

`authoring` also owns the public transparent-bucket configuration helpers and
their four named modes. A consumer that composes sprites with an existing 3D
game may set the world-level mode here; it should not reach into `/internal`.

The root barrel does not expose frame stores, extract/prepare/record stages,
or concrete pipeline implementation machinery. The supported custom-pipeline
operations are `RenderPipeline`, `RenderPipelineContext`, and the documented
render-graph primitives.

`@forgeax/engine-render/internal` is an engine-owned assembly seam, not an
application API or a compatibility route. Imports from `/internal` under the
private `apps/` tree are engine dogfood for assembly coverage, not application
recipes. First-party packages may use it while the engine is assembled;
application code should not copy those imports. Its
surface can change without a consumer migration promise. If a custom renderer
needs a capability absent from the supported root operations, treat that as a
request for an explicit public design rather than importing `/internal`.

For a custom `RenderPipeline` with `Camera.antialias = ANTIALIAS_MSAA`, declare
the scene colour and depth targets with `sample: 4`, add a single-sample colour
resolve target, and pass its key through `addScenePass(..., { resolve })`.
Downstream fullscreen passes read the resolve target; single-sample pipelines
omit `resolve`.

```mermaid
flowchart LR
  World["World data"] --> Extract["extract"]
  Extract --> Prepare["prepare"]
  Prepare --> Record["record"]
  Record --> Rhi["RHI submission"]
```

# `@forgeax/engine-render`

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

## RenderFeature: the producer seam

Register one producer-owned feature at the renderer assembly boundary. The
same `FrameData` type flows through `extract`, `prepare`, and `contribute`;
the host supplies ordering, capability projection, graph composition, and
lifecycle isolation.

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

Feature contexts expose only the current frame, opaque resource/target
handles, `Readonly<RhiCaps>`, and a structured error sink. Wave 1 stops at the
graph seam: `RenderFeaturePassContext` exposes the named pass and frame
identity, but intentionally does not expose raw GPU graphics state, pipeline
binding, vertex/index state, or a command encoder. This keeps a producer from
recording a WebGPU-invalid draw that cannot be backed by a feature-owned
pipeline and bindings. Do not cast the context to a raw device, complete
pipeline context, submit handle, or encoder; request a later prepared-graphics
seam instead.
Contribution declares named passes; their `execute` callbacks run in the
active RenderGraph and remain inside the frame's single execute/submit
boundary. The copyable recipe above is therefore a graph-only Wave 1 feature;
`addResource('color', ...)` is a graph declaration, not a prepared graphics
attachment or a promise that a producer can draw to it in Wave 1;
it proves ordering, resource lifetime, and ownership without claiming a GPU
draw capability that this seam does not implement. See
[`features/graph-contribution.ts`](src/features/graph-contribution.ts) for the
staging shape.

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
> Wave 2 deliberately stops at the prepared public seam. A visible particle
> draw path, particle simulation, VFX production branch, new asset manifest,
> RPC/CLI transport, and private `/internal` application import are out of
> scope. The hello-triangle visual check remains the falsification baseline.

Dynamic consumers use the same boundary explicitly:

```ts
const { Camera, MeshFilter, MeshRenderer } = await import('@forgeax/engine-render');
```

`@forgeax/engine-runtime` remains the host assembly entry for `createRenderer` and backend policy. Import `Materials` from this package. Runtime is not a compatibility barrel for render components.

Optional text, tilemap, and sprite authoring is intentionally isolated from the
base vocabulary:

```ts
import { GlyphText, SpriteAnimation, Tilemap } from '@forgeax/engine-render/authoring';
```

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

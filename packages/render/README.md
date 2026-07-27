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

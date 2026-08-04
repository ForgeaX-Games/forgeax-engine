---
name: forgeax-engine-app
description: >-
  ForgeaX application bootstrap and browser frame loop. Use when creating an App,
  selecting a World time policy, handling Result failures, migrating former frame
  callbacks to Update systems, wiring input and plugins, or attaching the opt-in
  Profiler capability.
---

# forgeax-engine-app

> **`createApp` is a host adapter, not a second scheduler.** It measures one browser delta, calls `world.update(deltaSeconds)`, then draws. Game behavior belongs in ECS `Update` or `FixedUpdate` systems.

## One-screen takeoff

```ts
import { createApp } from '@forgeax/engine-app';
import { Time, Update } from '@forgeax/engine-ecs';
import { forgeaxBundlerAdapter } from 'virtual:forgeax/bundler';

const result = await createApp(canvas, {}, forgeaxBundlerAdapter());
if (!result.ok) {
  console.error(result.error.code, result.error.hint);
  throw result.error;
}

const app = result.value;
app.world.addSystem(Update, {
  name: 'move-player',
  queries: [],
  fn: (world) => {
    const delta = world.getResource(Time).delta;
    void delta;
  },
}).unwrap();
app.start().unwrap();
```

The canvas form creates its World, renderer, default plugins, browser input backend, and frame loop. `app.start()` only arms the browser loop after the factory Result is successful.

## Optional CPU profiling

Attach `@forgeax/engine-profiler` to the App or Renderer assembly when a bounded CPU artifact is
needed. The default is off: no profiler means no capture records or profiler-owned event objects.

```ts
import { createProfiler } from '@forgeax/engine-profiler';
import { createApp } from '@forgeax/engine-app';

const profiler = createProfiler();
const result = await createApp({ renderer, world, profiler });
if (!result.ok) throw result.error;

const capture = profiler.startCapture({ frameLimit: 120, eventLimit: 1024 });
if (!capture.ok) throw capture.error;
// Drive the App, then call capture.value.finish() and validate the artifact.
```

Read `profiler.phaseCatalog` for the App/Render owner relation. Use
`validateProfileCapture` and `buildProfileModel` from the profiler package for offline analysis;
do not recreate phase lists or turn this capability into an ECS, GPU, UI, or RPC surface.

## Renderer feature assembly

When a producer owns an optional render contribution, pass it through the
single renderer assembly seam. `RenderFeature` and its `FrameData` type come
from `@forgeax/engine-render`; `createRenderer` comes from
`@forgeax/engine-runtime`.

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
    void data.visibleCount;
    context.staging.addPass('named-pass', {
      reads: [],
      writes: [],
      execute: ({ pass }) => void pass,
    }).unwrap();
    return ok(undefined);
  },
} satisfies RenderFeature<FrameData>;

const renderer = await createRenderer(canvas, { features: [feature] });
```

### Prepared graphics and recovery

For a producer that needs prepared graphics, keep the public imports split by
owner: `RenderFeature` and prepared declarations come from
`@forgeax/engine-render`, `createRenderer` comes from
`@forgeax/engine-runtime`, and producer data such as `ParticleRenderBatch`
comes from `@forgeax/engine-vfx`.

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

This prepares an opaque host reference only. It does not add a visible
particle draw path, simulation, VFX production branch, manifest, RPC/CLI
surface, or private import; those are explicit Wave 2 out-of-scope items.

Use `renderer.renderFeatureDiagnostics()` as the first recovery signal. The
snapshot has `identity`, `order`, `status`, and `latestError`. Branch on the
closed `latestError.code` union and read its `hint`/`detail`; do not parse
console messages or import `@forgeax/engine-render/internal`. Correct a
`failed` feature for the next frame, call `renderer.recover()` for a
`disabled` feature after capability/device recovery, fix registration or pass
order conflicts at the producer boundary, and treat `disposed` as terminal.
`renderer.dispose()` is idempotent. A pipeline switch preserves registration
and rebuilds the active graph.

For terminology and the public context boundary, use
[`@forgeax/engine-render`](../../packages/render/README.md) and its
[`prepared graphics declaration`](../../packages/render/src/features/prepared-graphics.ts).
For the runtime host contract, use
[`packages/runtime/README.md`](../../packages/runtime/README.md). For producer
batch data, use [`packages/vfx/README.md`](../../packages/vfx/README.md).

## Frame-loop contract

Each frame has one host-owned sequence:

```text
measured deltaSeconds -> world.update(deltaSeconds) -> renderer.draw([world], { owner: 0 })
```

`createApp` measures the delta once. A `World` owns time integration, fixed-step catch-up, and `Time` / `FixedTime` resources. Do not add a callback list, app-owned elapsed clock, app-side time clamp, or a second requestAnimationFrame loop.

The frame loop reports a failed world update or draw through `app.onError`. It does not swallow structured failures.

```ts
const stopListening = app.onError((error) => {
  console.error(error.code, error.hint);
});

const started = app.start();
if (!started.ok) console.error(started.error.code, started.error.hint);

// Later: stopListening(); app.stop();
```

## Time policy wiring

Canvas-form callers configure the new World at creation. The policy lives with the World, not with App.

```ts
const result = await createApp(canvas, {
  time: {
    fixedDeltaSeconds: 1 / 60,
    maxStepsPerUpdate: 4,
    maxDeltaSeconds: 0.1,
  },
});
```

`Time.delta` is the validated variable delta, `Time.elapsed` is its accumulated time, and `FixedTime` exposes the fixed delta, tick count, and truncation metrics. Read those resources in systems. `FixedTime.droppedSeconds` and `FixedTime.droppedUpdates` report a capped catch-up; they are not an invitation to restore an app-level clamp.

For the assemble form, the host creates the World first. Its existing policy is authoritative.

```ts
import { World } from '@forgeax/engine-ecs';
import { createApp } from '@forgeax/engine-app';

const world = new World({ time: { fixedDeltaSeconds: 1 / 120, maxStepsPerUpdate: 8 } });
const result = await createApp({ renderer, world, plugins: [myPlugin] });
if (!result.ok) throw result.error;
result.value.start().unwrap();
```

## Callback deletion migration

The former `registerUpdate` callback surface is deleted. Convert each callback into a named `Update` system. The system reads time from the World and participates in schedule ordering.

```ts
import { Time, Update, defineSystem } from '@forgeax/engine-ecs';

const AnimateHud = defineSystem({
  name: 'animate-hud',
  queries: [],
  fn: (world) => {
    const elapsed = world.getResource(Time).elapsed;
    updateHud(Math.sin(elapsed));
  },
});

app.world.addSystem(Update, AnimateHud).unwrap();
```

For deterministic simulation, register the behavior on `FixedUpdate` instead. Use schedule edges or sets for ordering; never recreate an app callback queue.

```ts
import { FixedUpdate } from '@forgeax/engine-ecs';

app.world.addSystem(FixedUpdate, {
  name: 'step-combat',
  queries: [],
  fn: () => stepCombat(),
}).unwrap();
```

## Input and plugin wiring

The canvas form inserts the input backend and activates the input scan on `Update` before user systems. User systems read the frozen `InputSnapshot`; they do not install gameplay DOM listeners.

```ts
import { INPUT_SNAPSHOT_RESOURCE_KEY, type InputSnapshot } from '@forgeax/engine-input';
import { Update, defineSystem } from '@forgeax/engine-ecs';

const ReadInput = defineSystem({
  name: 'read-input',
  queries: [],
  fn: (world) => {
    const input = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
    if (input.keyboard.down('KeyW')) moveForward();
  },
});
app.world.addSystem(Update, ReadInput).unwrap();
```

Use `plugins` to compose optional capability packages such as physics and audio. An assemble-form host supplies its own World, renderer, input backend, and plugin set explicitly.

## Boundaries

- `createApp` returns `Result`; handle `.ok`, `.error.code`, and `.error.hint` before starting.
- `createRenderer` is lower level. A host using it directly owns `world.update(deltaSeconds)` and `renderer.draw` itself.
- The app owns browser lifecycle and error fan-out; the World owns game scheduling and time.
- A demo that freezes after migration exposes an engine or schedule integration failure. Do not add a demo-side callback or manual loop workaround.

For exact option, Result, lifecycle, input, and renderer contracts, read `packages/app/README.md`, `packages/app/src/types.ts`, and `packages/app/src/internal/frame-loop.ts`.

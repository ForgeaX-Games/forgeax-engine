---
name: forgeax-engine-app
description: >-
  ForgeaX App assembly, execution tiers, and browser frame ownership. Use when
  bootstrapping a game, selecting time or worker policy, wiring plugins/input/profiling,
  or diagnosing execution and rebuild reports.
---

# forgeax-engine-app

## Render happy path

The app host follows `RenderScene -> Standard Pipeline -> DeviceScope -> FrameReceipt`.
Use `createApp`, then let the host perform `attach -> draw`; use `inspect`, `observe`, and `recover`
with the returned receipt. Domain producers keep their own assets, input, audio, and plugin owners.

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

## Worker execution

```ts
const result = await createApp(canvas, {
  execution: {
    tier: 'auto',
    bootstrap: new URL('./game-bootstrap.mjs', import.meta.url),
  },
}, forgeaxBundlerAdapter());
if (!result.ok) throw result.error;

const app = result.value;
app.start().unwrap();
const report = app.execution.report();
```

| Need | Action |
|:--|:--|
| Maximum compatibility | Request `auto`; inspect `actualTier` and `selectionReason` |
| Guaranteed Engine Worker | Request `engine-worker`; handle an unavailable-capability `AppError` |
| Shared numeric Kernels | Request `shared`; serve COOP/COEP and verify SAB/Atomics facts in the report |
| Partial Kernel write | Stop using the old World; call `app.execution.rebuild()` and use the new identity |

World, Renderer, and WebGPU stay together in the Engine Worker. The Host owns DOM input, one-credit rAF pacing, Web Audio, and diagnostic projection. Shared Kernel Workers receive only bound numeric spans. Use [`packages/app/schema/execution-report.schema.json`](../../packages/app/schema/execution-report.schema.json) as the report authority and [`forgeax-engine-ecs`](../forgeax-engine-ecs/SKILL.md) for Kernel eligibility.

When a host temporarily hands the presentation surface to another carrier
(for example, a disposable Play iframe or Tauri WebView), use
`await app.releaseSurfacePreserveWorld()` before mounting the new owner and
`await app.restoreSurface()` after it is destroyed. This preserves the exact
Edit World and Renderer identity; `app.stop()` and `renderer.dispose()` are
not relocation APIs. `app.stop()` only stops frame scheduling; `app.dispose()`
drains the plugin realm and releases the renderer.

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

## Render-owned evidence boundary

Render inspection and profiling are the evidence boundary. App exposes the
renderer `inspect` and `observe` projections and forwards the opt-in profiler;
it does not define a timing controller, timestamp vocabulary, or
membership-specific option.

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
  plan: (data, context) => {
    void data.visibleCount;
    void context;
    return ok({ resources: [], passes: [] });
  },
} satisfies RenderFeature<FrameData>;

const created = await createRenderer(canvas, { features: [feature] });
if (!created.ok) throw created.error;
const renderer = created.value;
```

### Declarative graphics and recovery

For a producer that needs graphics or compute, declare the work in its plan.
The public imports stay split by owner: `RenderFeature` and plan declarations
come from `@forgeax/engine-render`; `createRenderer` comes from
`@forgeax/engine-runtime`.

```ts
import { ok } from '@forgeax/engine-types';
import type { RenderFeature } from '@forgeax/engine-render';
import { createRenderer } from '@forgeax/engine-runtime';
interface PreparedFrame {
  readonly visibleCount: number;
}

const frame: PreparedFrame = { visibleCount: 0 };
const feature = {
  identity: 'package.prepared-feature',
  extract: () => ok(frame),
  plan: (_data, context) => {
    return ok({
      resources: [{
        kind: 'graphics-program',
        name: 'package.pipeline',
        program: {
          shader: 'package.shader',
          vertexLayout: 'package.vertices',
          colorFormats: [context.targets[0]?.format ?? 'rgba8unorm-srgb'],
          sampleCount: 1,
          topology: 'triangle-list',
        },
      }],
      passes: [],
    });
  },
} satisfies RenderFeature<PreparedFrame>;

const created = await createRenderer(canvas, { features: [feature] });
if (!created.ok) throw created.error;
const renderer = created.value;
```

The host derives opaque GPU resources and graph access from this declaration.
The producer owns extracted facts; it never receives a device, encoder, queue,
or submit callback.

Use `renderer.inspect()` and the single `renderer.subscribe()` stream as the
recovery surface. Branch on the closed `RenderError` code and read its
structured detail; do not parse console messages or import a private assembly
seam. Call `renderer.recover()` after device loss and treat `disposed` as
terminal. `renderer.dispose()` is idempotent.

For terminology and the public context boundary, use
[`@forgeax/engine-render`](../../packages/render/README.md) and its
[`declarative feature plan`](../../packages/render/src/features/plan.ts).
For the runtime host contract, use
[`packages/runtime/README.md`](../../packages/runtime/README.md). For code-first
GPU particles, use [`packages/vfx-render/README.md`](../../packages/vfx-render/README.md).

## Frame-loop contract

Each frame has one host-owned sequence:

```text
measured deltaSeconds -> world.update(deltaSeconds) -> renderer.draw({ leases, camera, environment })
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

Use `plugins` to compose optional capability packages such as physics and audio. These are native DeepSeek Cordis plugins: declare `inject`/`provide`, register every reversible side effect through `ctx.effect`, and let the App-owned `pluginContext` own their Fibers.

```ts
import type { Plugin } from '@forgeax/engine-plugin';

const gameplay: Plugin = {
  name: 'gameplay',
  inject: ['world'],
  apply(ctx) {
    ctx.effect(() => installGameplaySystems(ctx.world));
  },
};

const fiber = await app.pluginContext.plugin(gameplay);
await fiber.dispose();
await app.dispose();
```

`app.stop()` only stops frame scheduling. `app.dispose()` drains the Cordis realm and then releases simulation/Host/renderer ownership. An assemble-form host supplies its own World, renderer, input backend, and plugin set explicitly; the App still owns the Context it assembled around them.

## Boundaries

- `createApp` returns `Result`; handle `.ok`, `.error.code`, and `.error.hint` before starting.
- `createRenderer` is lower level. A host using it directly owns `world.update(deltaSeconds)` and `renderer.draw` itself.
- The app owns browser lifecycle and error fan-out; the World owns game scheduling and time.
- A demo that freezes after migration exposes an engine or schedule integration failure. Do not add a demo-side callback or manual loop workaround.

For exact option, Result, lifecycle, input, and renderer contracts, read `packages/app/README.md`, `packages/app/src/types.ts`, and `packages/app/src/internal/frame-loop.ts`.

## Simulation inspection

Pass already-created, ready simulation participants to `createApp`; App
registers them with the World and exposes one read-only inspection summary.
Use `app.simulationInspection()` for participant/readiness, baseline, trace,
report, tolerance, and structured error diagnostics. The schema is
`packages/app/schema/simulation-inspection.schema.json`.

App does not define record/schema/component state or restore policy. Preview and
Remote only consume the summary through existing read/eval paths. Do not add
restore/replay actions or transport raw World, Rapier, or Web Audio objects.

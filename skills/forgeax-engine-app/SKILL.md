---
name: forgeax-engine-app
description: >-
  ForgeaX application bootstrap and browser frame loop. Use when creating an App,
  selecting a World time policy, handling Result failures, migrating former frame
  callbacks to Update systems, wiring input and plugins, or attaching the opt-in
  Profiler capability. Use also when selecting main-serial, engine-worker, or shared
  execution and diagnosing capability, performance, poison, or rebuild reports.
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
terminal teardown and are not relocation APIs.

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

## Render-owned deferred membership timing

`CreateAppOptions.membershipTiming` is forwarded unchanged to Render through
Runtime. Omission performs no timing work. `cpu-control` is an independent CPU
control route and never emits GPU timestamps; `gpu` is a bounded opt-in that
can be refused by backend capability. App does not define timing statuses,
reasons, timestamp units, or a generic profiler. Read the Render contract in
[`packages/render/src/record/membership-timing.ts`](../../packages/render/src/record/membership-timing.ts).

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

For a producer that needs prepared graphics or compute, keep the public imports
split by owner: `RenderFeature` and prepared declarations come from
`@forgeax/engine-render`; `createRenderer` comes from
`@forgeax/engine-runtime`; the producer owns its extracted frame data.

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
} satisfies RenderFeature<PreparedFrame>;

const renderer = await createRenderer(canvas, { features: [feature] });
```

This prepares an opaque host reference only. The producer still owns its
compute, drawing, asset, and lifecycle policy; App remains a transparent host.

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
[`packages/runtime/README.md`](../../packages/runtime/README.md). For code-first
GPU particles, use [`packages/vfx-render/README.md`](../../packages/vfx-render/README.md).

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

## Simulation inspection

Pass already-created, ready simulation participants to `createApp`; App
registers them with the World and exposes one read-only inspection summary.
Use `app.simulationInspection()` for participant/readiness, baseline, trace,
report, tolerance, and structured error diagnostics. The schema is
`packages/app/schema/simulation-inspection.schema.json`.

App does not define record/schema/component state or restore policy. Preview and
Remote only consume the summary through existing read/eval paths. Do not add
restore/replay actions or transport raw World, Rapier, or Web Audio objects.

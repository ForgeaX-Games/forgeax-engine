---
name: forgeax-engine-ecs
description: >-
  ForgeaX archetype ECS: define SoA components and systems, attach systems to the
  Update or FixedUpdate schedule with token-first World APIs, and advance a World
  through world.update(deltaSeconds). Use when defining components, queries, systems,
  schedule ordering, fixed-step simulation, resources, relationships, reflection,
  shared numeric storage, QuerySpan kernels, or poisoned-World handling.
---

# forgeax-engine-ecs

> **A World owns exactly two schedules: `Update` for variable-rate work and `FixedUpdate` for fixed-rate work.** Register with a schedule token first, then advance both schedules through `world.update(deltaSeconds)`.

## One-screen takeoff

```ts
import { FixedUpdate, Time, Update, World, defineComponent } from '@forgeax/engine-ecs';

const Position = defineComponent('Position', { x: 'f32' });
const Velocity = defineComponent('Velocity', { x: 'f32' });
const world = new World({ time: { fixedDeltaSeconds: 1 / 60, maxStepsPerUpdate: 4 } });

world.addSystem(Update, {
  name: 'integrate-variable',
  queries: [{ write: [Position], read: [Velocity] }],
  fn: (current, [moving]) => {
    const delta = current.getResource(Time).delta;
    for (const row of moving) {
      row.mut(Position).x += row.get(Velocity).x * delta;
    }
  },
}).unwrap();

world.addSystem(FixedUpdate, {
  name: 'simulate-fixed',
  queries: [],
  fn: () => { /* deterministic fixed-rate work */ },
}).unwrap();

world.update(1 / 60).unwrap();
```

`Time` and `FixedTime` are World-owned resources. Systems read them; hosts never write time resources directly.

## Shared Kernel

```ts
import { Update, defineSharedKernel, type QuerySpan } from '@forgeax/engine-ecs';

function integrate(spans: readonly QuerySpan[]): void {
  for (const span of spans) span.mut(Position).x.fill(1);
}

world.addSystem(Update, defineSharedKernel(kernelModuleUrl, {
  name: 'integrate-shared',
  queries: [{ write: [Position] }],
  run: integrate,
})).unwrap();
```

Use `World({ storage: 'shared' })` only inside a selected shared Engine realm. A Kernel must be an independently loadable named module function with explicit read/write descriptors and numeric table fields. Optional, change-detection, sparse, object, DOM, GPU, and structural access is ineligible. Small work and pre-dispatch pool failure run inline; any failure after a possible shard write poisons the World and forbids retry. Recovery belongs to `app.execution.rebuild()`, not ECS mutation of the old identity.

## Schedule-scoped registration

All five scheduling mutations take the schedule token as their first argument. `Update` and `FixedUpdate` are nominal tokens, not strings.

```ts
import {
  FixedUpdate,
  Update,
  defineSystem,
  defineSystemSet,
} from '@forgeax/engine-ecs';

const Gameplay = defineSystemSet({ name: 'gameplay' });
const Movement = defineSystem({ name: 'movement', queries: [], fn: () => {} });
const Cleanup = defineSystem({ name: 'cleanup', queries: [], fn: () => {} });

world.addSystem(Update, Movement).unwrap();
world.addSystems(Update, Gameplay, [Movement, Cleanup]).unwrap();
world.configureSets(Update, { set: Gameplay }).unwrap();
world.removeSystem(Update, 'cleanup').unwrap();
world.replaceSystem(Update, 'movement', {
  name: 'movement',
  queries: [],
  fn: () => {},
}).unwrap();
```

A system belongs to the schedule selected at registration. Use `after: [FixedUpdate]` or `before: [FixedUpdate]` only as the intrinsic fixed-anchor edge inside `Update`; do not use it to smuggle a system between schedules.

### Migration from the pre-token form

The old single-schedule forms are deleted. Add the appropriate first argument (`Update` or `FixedUpdate`) to every registration and pass the host-measured `deltaSeconds` to each update call. The final shapes are `world.addSystem(Update, system)`, `world.addSystems(Update, set, systems)`, `world.configureSets(Update, options)`, and `world.update(deltaSeconds)`.

## Time policy and resources

```ts
import { FixedTime, Time, World } from '@forgeax/engine-ecs';

const world = new World({
  time: {
    fixedDeltaSeconds: 1 / 60,
    maxStepsPerUpdate: 4,
    maxDeltaSeconds: 0.1,
  },
});

world.update(0.2).unwrap();
const variable = world.getResource(Time);
const fixed = world.getResource(FixedTime);

console.log(variable.delta, variable.elapsed, variable.maxDeltaSeconds);
console.log(fixed.delta, fixed.tick, fixed.maxStepsPerUpdate);
console.log(fixed.droppedSeconds, fixed.droppedUpdates);
```

`world.update(deltaSeconds)` validates a finite non-negative delta, clamps it by `maxDeltaSeconds`, runs `Update` once, and drains `FixedUpdate` in fixed increments. If the cap prevents full catch-up, `FixedTime.droppedSeconds` and `FixedTime.droppedUpdates` report the discarded work. They are observable metrics, not errors and not an app-level clamp.

Use `Time.delta` for variable-rate integration and `Time.elapsed` for absolute-time behavior. Use `FixedTime.delta` for deterministic fixed simulation. A manually constructed World can run a zero-delta frame with `world.update(0)`.

## Scope failures and Result handling

Every schedule mutation and `world.update` returns `Result`. Handle errors by their closed `code` union:

```ts
const result = world.addSystem(Update, fixedOnlySystem);
if (!result.ok) {
  switch (result.error.code) {
    case 'schedule-scope-mismatch':
      console.error(result.error.hint);
      break;
    case 'system-before-unknown':
    case 'system-after-unknown':
    case 'system-set-not-registered':
      console.error(result.error.hint);
      break;
  }
}
```

`'schedule-scope-mismatch'` means a target system, set, or fixed anchor belongs to the other schedule. Keep dependent systems and sets in the same scope; do not catch and ignore the failure or add a compatibility registration path.

## Query model

`world.query(descriptor)` is the only query constructor. It returns `Result<Query, QueryCreationError>`.

| Role | Meaning | Row access |
|:--|:--|:--|
| `read` | required data, immutable intent | `row.get(Component)` |
| `write` | required data, mutation intent | `row.mut(Component)` |
| `optional` | data may be absent | `row.get(Component)` returns value or `undefined` |
| `with` / `without` | presence-only filter | no data access |
| `changed` / `added` | query-owned observation filter | no extra data permission |

`for...of query` is canonical. A yielded `QueryRow` is transient; consume it in the loop and retain `row.entity` when later work needs identity. Structural mutation invalidates active iteration with a structured ECS error.

```ts
const query = world.query({ read: [Health], with: [Enemy] }).unwrap();
for (const row of query) console.log(row.entity, row.get(Health).value);
```

Use `query.spans()` only for dense, table-only descriptors. It rejects optional data, row-level observation filters, and sparse components with `query-span-unavailable`. Span columns are zero-copy transient TypedArray views.

```ts
const query = world.query({ write: [Position], read: [Velocity] }).unwrap();
for (const span of query.spans().unwrap()) {
  const position = span.mut(Position).x;
  const velocity = span.get(Velocity).x;
  for (let i = 0; i < span.length; i++) position[i] = (position[i] ?? 0) + (velocity[i] ?? 0);
}
```

`query.combinations(k)` derives K-way iteration from the same query.

## Storage choice

`defineComponent` uses table storage unless the token explicitly declares a zero-field sparse tag.

```ts
const Enemy = defineComponent('Enemy', {});
const Selected = defineComponent('Selected', {}, { storage: 'sparse' });
```

Use table storage for every data component and for stable identity tags. Use sparse only for frequently flipped membership. Sparse tags still participate in Archetype identity, hooks, cardinality, scene round-trip, inspection, and ordinary row queries, but Archetypes that differ only by sparse membership share the same physical Table.

Sparse tags have no fields, so they belong in `with`, `without`, `changed`, or `added`, never `read`, `write`, or `optional`. A sparse predicate makes `query.spans()` return `query-span-unavailable` with reason `sparse-component`; use row iteration for that query. `Disabled` is always a table tag.

## Systems and structural mutation

Systems receive the owning `World`, a tuple of persistent Query objects, and deferred `Commands`. Use `commands` for structural changes; the schedule flushes them at defined boundaries.

```ts
import { Update, defineComponent } from '@forgeax/engine-ecs';

const Health = defineComponent('Health', { value: 'f32' });
world.addSystem(Update, {
  name: 'remove-dead',
  queries: [{ read: [Health] }],
  fn: (_world, [health], commands) => {
    for (const row of health) {
      if (row.get(Health).value <= 0) commands.despawn(row.entity);
    }
  },
}).unwrap();
```

For component schema, storage, relationship, reflection, and errors, read `packages/ecs/README.md` and `packages/ecs/src/`. Scheduling is token-first and query construction has one entry; no compatibility overload exists.

## Visibility inspection quick start

```ts
const render = await _import('@forgeax/engine-render');
const query = world.query({ read: [render.Visibility] }).unwrap();
for (const row of query) console.log(row.get(render.Visibility).state);
const effective = render.resolveVisibility(world).effective(entity);
```

| Observation | Read from | Do not infer |
|:--|:--|:--|
| Current | `QueryRow.get` and `Visibility.state` | Final render participation |
| Effective | `resolveVisibility(world)` | Camera or picking state |
| Invalid write | `Result.error.code`, `.expected`, `.hint`, `.detail` | A message-only failure |

If a write fails, use the reflected enum labels to choose a valid value and
retry `world.set`. If effective resolution reports hierarchy diagnostics, repair
the scene relation before retrying. The app host only transports JSON-safe
reflection; ECS remains the component owner.

Out of scope: renderer culling, camera, picking, app lifecycle, assets, and VFX
shadow policy. Route each question to its owning package skill.

## Simulation record/restore seam

Use the ECS owner when deterministic fixed-tick state must be restored into a
fresh target and compared semantically. The minimum path is
`source.simulationRecord()` -> `target.simulationRestore(record)` ->
`simulationCompare({ facts })`.

`trace` contains ordered fixed-tick input samples. A `participant` is one ready,
versioned owner for portable external state. Every numeric report fact declares
a non-negative `tolerance`. Expected failures are closed errors; switch on
`code` and read `expected`, `hint`, and narrowed `detail`.

The App, Preview, and Remote boundaries expose only the inspection summary and
the schema at `packages/app/schema/simulation-inspection.schema.json`. They do
not own record/schema state or provide restore/replay actions. Do not use this
seam for network rollback, disk persistence, RHI tape replay, game replay, or
pixel comparison.

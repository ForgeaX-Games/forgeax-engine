---
name: forgeax-engine-ecs
description: >-
  ForgeaX archetype ECS: define SoA components and systems, attach systems to the
  Update or FixedUpdate schedule with token-first World APIs, and advance a World
  through world.update(deltaSeconds). Use when defining components, queries, systems,
  schedule ordering, fixed-step simulation, resources, relationships, or reflection.
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
  queries: [{ with: [Position, Velocity] }],
  fn: (current, results) => {
    const delta = current.getResource(Time).delta;
    for (const bundle of results[0]) {
      for (let index = 0; index < bundle.entityCount; index++) {
        bundle.Position.x[index] += bundle.Velocity.x[index] * delta;
      }
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

## System and query model

Components are SoA columns. A system receives the owning `World`, typed query bundles, and a deferred `Commands` buffer. Perform structural changes through `commands` inside a system, then let the schedule flush them at its defined boundary.

```ts
import { Update, defineComponent } from '@forgeax/engine-ecs';

const Health = defineComponent('Health', { value: 'f32' });
world.addSystem(Update, {
  name: 'remove-dead',
  queries: [{ with: [Health] }],
  fn: (_world, results, commands) => {
    for (const bundle of results[0]) {
      for (let index = 0; index < bundle.entityCount; index++) {
        if (bundle.Health.value[index] <= 0) commands.despawn(bundle.Entity.self[index]);
      }
    }
  },
}).unwrap();
```

For component schema, query, relationship, reflection, and scene APIs, read `packages/ecs/README.md` and the source contracts in `packages/ecs/src/`. The current scheduling surface is always token-first; no compatibility overload exists.

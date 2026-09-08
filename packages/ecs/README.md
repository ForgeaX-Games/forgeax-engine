# `@forgeax/engine-ecs`

Archetype ECS for ForgeaX. The package owns the hot path shared by every
domain: entity identity, component storage, relationships, queries, structural
mutation, two schedules, resources, time, and optional shared numeric kernels.

> [!IMPORTANT]
> `World` is the state authority. Scene instances, render extraction, physics
> backends, asset ownership, input collection, and application lifecycle stay
> in their owning packages. Do not add a second ECS facade for one of those
> domains.

```mermaid
flowchart LR
  HOST["App host"] --> WORLD["World.update(delta)"]
  WORLD --> FIXED["FixedUpdate"]
  FIXED --> UPDATE["Update + command flush"]
  UPDATE --> PUBLISH["Scene / render projections"]
  WORLD --> QUERY["Query row / span"]
  WORLD --> JOURNAL["Bounded change journal"]
  JOURNAL --> PROJECTION["ecs/projection"]
```

## The smallest useful journey

```ts
import type { Result } from '@forgeax/engine-types';
import {
  type EcsError,
  FixedTime,
  Update,
  World,
  defineComponent,
  defineSystem,
} from '@forgeax/engine-ecs';

const Position = defineComponent('Position', {
  x: { type: 'f32', default: 0 },
  y: { type: 'f32', default: 0 },
});

const Move = defineSystem({
  name: 'move',
  queries: [{ write: [Position] }],
  fn: (_world, [positions]) => {
    for (const row of positions) {
      const position = row.mut(Position);
      position.x += 1;
    }
  },
});

const world = new World();
const spawned = world.spawn({ component: Position, data: { x: 0, y: 0 } });
if (!spawned.ok) throw spawned.error;
const registered = world.addSystem(Update, Move);
if (!registered.ok) throw registered.error;
const stepped: Result<void, EcsError> = world.update(1 / 60);
if (!stepped.ok) console.error(stepped.error.code, stepped.error.hint);
```

The normal data path is `world.query(descriptor)` with a row iterator or a
packed `QuerySpan`. Success-path row access is direct and allocation-free;
expected boundary failures use the shared `Result` carrier from
`@forgeax/engine-types`.

## Components and schema

`defineComponent` accepts one closed storage vocabulary. The token exposes only
the schema facts needed by a consumer: `name`, frozen `fields`, and `storage`.
Authoring metadata, lifecycle callbacks, render policy, simulation policy, and
open-ended metadata do not belong on a component token.

| Shape | Use | Example |
|:--|:--|:--|
| scalar | numeric, boolean, or enum data | `{ type: 'f32', default: 0 }` |
| `string` | managed text value | `{ type: 'string', default: '' }` |
| `entity` | raw entity reference | `{ type: 'entity' }` |
| `shared<Tag>` | externally owned shared payload handle | `{ type: 'shared<MeshAsset>' }` |
| `array<T>` | variable array replaced as one value | `{ type: 'array<f32>' }` |
| `array<T,N>` | fixed-size inline array | `{ type: 'array<f32, 4>' }` |
| sparse tag | presence-only marker | `defineComponent('Disabled', {})` |

The `fields` object is deeply frozen at definition time. A value replacement
uses the ordinary mutation path:

```ts
const Trail = defineComponent('Trail', { points: { type: 'array<f32>' } });
const entity = world.spawn({ component: Trail, data: { points: new Float32Array([0, 1]) } }).unwrap();
const current = world.get(entity, Trail).unwrap();
world.set(entity, Trail, { points: new Float32Array([...current.points, 2]) });
```

The Scene package may define a single-field `Name { value: 'string' }` token
for authoring. ECS stores the value through the same closed `string` schema
vocabulary, but does not own the Scene component or its authoring policy.

Scene and Render own their domain schemas, for example `Instances { transforms`
is a Render-owned projection whose array payload still follows ECS replacement
semantics.

There is no public `push`, `pop`, `capacity`, `reserveArrayCapacity`, view
class, or user-managed target-array mutation API. A replacement is one bounded
mutation, so an invalid value leaves the previous column and reference counts
unchanged.

Object-shaped numeric writes reject `NaN` before touching the column. The
returned `component-numeric-value-invalid` error carries the component, field,
entity, received value, and optional array index in `detail`; `Infinity` remains
valid when the schema accepts it. Branch on `error.code` and use `error.hint` to
choose the correction instead of parsing a message.

## Relationships: one source, one materialized index

Relationships preserve the reverse index because lookup complexity is part of
the contract. Reading a parent's children is $O(1 + k)$ for $k$ direct children,
not an $O(N)$ scan of every entity. The source is the only writable fact; the
target is an engine-maintained, read-only materialized vector with a
source-to-slot backpointer for amortized $O(1)$ attach, detach, and reparent.

```ts
import { defineRelationship } from '@forgeax/engine-ecs';

const { source: ChildOf, target: Children } = defineRelationship({
  sourceName: 'ChildOf',
  sourceField: 'parent',
  targetName: 'Children',
  targetField: 'entities',
  exclusive: true,
  linkedSpawn: true,
});

const parent = world.spawn().unwrap();
const child = world.spawn({ component: ChildOf, data: { parent } }).unwrap();
const children = world.get(parent, Children).unwrap().entities;
```

`Children` and `AnimationTargets` are read projections, not a second write
authority. `Children { entities` is a materialized target owned by ECS; the
Scene package owns the `ChildOf` vocabulary and chooses where to use it. The
same rule applies to `AnimationTargets`. Direct target writes are rejected by
`World` at both the type and runtime boundaries.

## Queries and projections

Queries are the only public data-plane API. A row is the flexible path; a span
is the packed numeric path and includes entity handles for owner-side identity.
Raw `Table`, `Archetype`, `Column`, and `FieldView` values are package-private.

```ts
const query = world.query({ read: [Position] }).unwrap();
for (const row of query) console.log(row.entity, row.get(Position).x);
const writable = world.query({ write: [Position] }).unwrap();
for (const span of writable.spans().unwrap()) {
  const positions = span.mut(Position);
  for (let i = 0; i < span.length; i += 1) positions.x[i] += 1;
}
```

Incremental owners use the explicitly named projection subpath. It carries
bounded change evidence only; a full rebuild uses the ordinary query path.

```ts
import { createWorldProjection } from '@forgeax/engine-ecs/projection';

const projection = createWorldProjection(world, { components: [Position] });
const next = projection.poll();
if (next.status === 'rebuild') {
  // Rebuild the owner's cache with world.query(...).spans().
} else {
  for (const change of next.changes) console.log(change.entity, change.kind);
}
```

Projection output never contains table ids, rows, columns, or a duplicate
snapshot data plane.

## Schedules, time, and resources

Only `Update` and `FixedUpdate` are user schedules. Registration is token-first;
there is no frame-end schedule, system-parameter DSL, terminal render hook, or
severity/error-handler registry.

```ts
world.addSystem(Update, Move).unwrap();
world.addSystem(FixedUpdate, {
  name: 'fixed-step',
  queries: [],
  fn: (fixedWorld) => {
    const fixed = fixedWorld.getResource(FixedTime);
    void fixed.tick;
  },
}).unwrap();
```

`world.update(deltaSeconds)` advances the clock, runs zero or more fixed steps,
runs one update step, and flushes each system's command buffer. Clock readers
receive a stable read view; the scheduler owns writes. Resources are non-owning
values: Cordis/plugin owners dispose external payloads, not `World`.

## Failure and recovery

Branch on `error.code`, never on a message string. The closed ECS error union
preserves `code`, `expected`, `hint`, `detail`, and `cause` where applicable.

```ts
const result = world.update(1 / 60);
if (!result.ok) {
  switch (result.error.code) {
    case 'world-poisoned':
      // Stop the frame and ask the App execution owner to rebuild.
      break;
    default:
      console.error(result.error.code, result.error.hint);
  }
}
```

Expected command failures are reported before structural commit and leave the
World unchanged. A system throw or an unknown post-write failure cannot prove
that no row was mutated: the World becomes poisoned and must be rebuilt by the
App execution owner. Shared-kernel partial writes follow the same fail-closed
rule.

```mermaid
stateDiagram-v2
  [*] --> Healthy
  Healthy --> Healthy: expected failure / zero delta
  Healthy --> Poisoned: system throw or partial write
  Poisoned --> Rebuilt: App stops frame and replaces World
  Rebuilt --> Healthy
```

## Inspection

`world.inspect()` is an explicit, detached, deeply frozen POD snapshot for
diagnostics. It is not a live registry and is not a storage escape hatch.
Consumers should use entity counts, active component names, schedule summaries,
and resource keys; gameplay code should use queries.

## Public surface and subpaths

The root barrel is intentionally small. Advanced capabilities are named by
their owner instead of being forwarded through the root.

| Entry | Purpose |
|:--|:--|
| `@forgeax/engine-ecs` | World, components, relationships, queries, schedules, resources, errors |
| `@forgeax/engine-ecs/projection` | Bounded change cursor and rebuild signal |
| `@forgeax/engine-ecs/shared` | Shared numeric kernel contracts |
| `@forgeax/engine-ecs/externalization` | Generic component projection and entity remap |

`Result`, `ok`, `err`, and `Handle` come from `@forgeax/engine-types`; ECS does
not forward them. There is no ECS remote bin, simulation record/restore
protocol, scene-instance resolver, or compatibility alias for removed APIs.

<details>
<summary>Removed concepts</summary>

The one-cut surface deliberately removes `FrameEnd`, `setErrorHandler`,
`defineSystemParam`, `ParamValidation`, simulation record/restore/trace APIs,
scene lifecycle methods, raw storage exports, relationship metadata lookup,
root `Result`/`Handle` forwarding, and array convenience commands. When a
consumer needs one of those concerns, move the owner to App, Scene, Render,
Physics, or the explicitly named ECS subpath.
</details>

## Verification

- [x] Entity and component mutation use one World authority.
- [x] Relationship targets remain materialized for $O(1 + k)$ reads.
- [x] Query row/span are the only public data plane.
- [x] `Update` and `FixedUpdate` are the only schedules.
- [x] Expected failures are structured; unknown partial writes poison the World.
- [x] Advanced projection/shared/externalization APIs are named subpaths.

For the full migration rationale and acceptance matrix, see the canonical
[ECS 80% architecture design](../../.forgeax-harness/docs/specs/2026-08-22-ecs-core-80-percent-architecture-reduction-design.md).

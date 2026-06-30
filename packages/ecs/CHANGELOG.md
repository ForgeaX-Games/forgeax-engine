# @forgeax/engine-ecs — Changelog

All notable changes to this package are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this package adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed (BREAKING)

Five public-API signatures gained an additional generic parameter so query
column-bundle field types flow through to callbacks **without** `as` casts or
`as const` annotations. Default generic arguments preserve the prior shape, so
non-annotated call sites stay zero-modification — but call sites that
**explicitly** wrote the old non-generic types must drop those annotations and
let inference take over (see Migration below).

- `QueryDescriptor` is now `QueryDescriptor<Cs extends readonly Component[] = readonly Component[]>`. Field `with: Cs` (was `readonly Component[]`).
- `QueryState` is now `QueryState<Cs extends readonly Component[] = readonly Component[]>`. Field `descriptor: QueryDescriptor<Cs>`.
- `createQueryState` is now `createQueryState<const Cs extends readonly Component[] = readonly Component[]>(descriptor: QueryDescriptor<Cs>, world): QueryState<Cs>`. The `const Cs` modifier locks the `with` literal as a tuple.
- `queryRun` is now `queryRun<Cs extends readonly Component[]>(state: QueryState<Cs>, world, callback: (bundle: NestedColumnBundle<NoInfer<Cs>>) => void): void`. `NoInfer` blocks callback bodies from feeding back into `Cs`.
- `SystemDescriptor` is now `SystemDescriptor<Qs extends readonly QueryDescriptor[] = readonly QueryDescriptor[]>`. The `fn` first parameter is mapped over `Qs`: `queryResults[i][j]` recovers `NestedColumnBundle<Qs[i]['with']>`.
- `world.addSystem` (class method) and `addSystem` (free function) both gained `<const Qs extends readonly QueryDescriptor[]>` so the call-site `queries` tuple is locked.

### Added

- `Component<N extends string = string, S extends ComponentSchema = ComponentSchema>` — the component name `N` is now a type-level string-literal slot. `defineComponent<const N>` lifts the name argument so `NestedColumnBundle<Cs>` can mapped-type over it; `bundle.Position.x` resolves to a concrete TypedArray rather than a `... | undefined` index-signature path (KD-1; addresses TS18048 under `noUncheckedIndexedAccess`).
- JSDoc `@example` blocks on `createQueryState`, `queryRun`, and `SystemDescriptor` — three discovery surfaces with a congruent 30-second minimal example.
- `packages/ecs/src/__tests__/minimal-example.test-d.ts` — compile-assertion vehicle that pastes the minimal example so each release certifies AI users can write bundle-field access without `as` casts.

### Migration

Three call-site shapes trip on the breaking changes. The fix is the same in all
three: **delete the explicit annotation and let inference take over.**

#### Explicit `ColumnBundle` annotation on a `queryRun` callback

Pre-feature `queryRun` callbacks sometimes annotated the bundle param with the
non-nested `ColumnBundle` to satisfy older `as const` workflows. After this
release, the callback infers `NestedColumnBundle<Cs>` directly — keeping the
`ColumnBundle` annotation hides the per-component fields.

Before:

```ts
import { createQueryState, queryRun, type ColumnBundle } from '@forgeax/engine-ecs';

const state = createQueryState({ with: [Position, Velocity] }, world);
queryRun(state, world, (bundle: ColumnBundle) => {
  const xs = (bundle.Position as { x: Float32Array }).x; // hand-rolled cast
});
```

After:

```ts
import { createQueryState, queryRun } from '@forgeax/engine-ecs';

const state = createQueryState({ with: [Position, Velocity] }, world);
queryRun(state, world, (bundle) => {
  const xs = bundle.Position.x; // Float32Array — inferred
});
```

#### Explicit `SystemDescriptor` annotation on a system literal

Older code occasionally pre-typed the system descriptor object as
`SystemDescriptor` to keep editor tooling happy. The default-parametrised
`SystemDescriptor` collapses `Qs` to `readonly QueryDescriptor[]`, so `fn`'s
first parameter falls back to `ColumnBundle[][]` and per-component access
breaks. Drop the annotation and let `addSystem`'s `const Qs` infer.

Before:

```ts
import { type SystemDescriptor } from '@forgeax/engine-ecs';

const desc: SystemDescriptor = {
  name: 'movement',
  queries: [{ with: [Position, Velocity] }],
  fn: (queryResults) => {
    // queryResults[0][0].Position.x — does not compile under default Qs
  },
};
world.addSystem(desc);
```

After:

```ts
world.addSystem({
  name: 'movement',
  queries: [{ with: [Position, Velocity] }],
  fn: (queryResults) => {
    // queryResults[0][0].Position.x — Float32Array, inferred via const Qs
    queryResults[0][0]?.Position.x;
  },
});
```

#### Single-parameter `Component<S>` annotation

`Component` gained the leading `N extends string = string` parameter. Existing
call sites that wrote `Component<{ x: 'f32' }>` continue to compile because
`N` defaults to `string`, but APIs whose return type was annotated as
`Component<{ ... }>` now resolve to `Component<string, { ... }>`. To retain
the literal-name signal for downstream `NestedColumnBundle` inference, switch
to inferring via `defineComponent` — it lifts the name to its literal type
automatically.

Before:

```ts
import { type Component, defineComponent } from '@forgeax/engine-ecs';

function makePos(): Component<{ x: 'f32'; y: 'f32' }> {
  return defineComponent('Position', { x: 'f32', y: 'f32' });
}
```

After:

```ts
import { defineComponent } from '@forgeax/engine-ecs';

// Inferred: Component<'Position', { x: 'f32'; y: 'f32' }>
const Position = defineComponent('Position', { x: 'f32', y: 'f32' });
// Or, if an explicit annotation is required:
//   Component<'Position', { x: 'f32'; y: 'f32' }>
```

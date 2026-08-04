# `@forgeax/engine-scene`

> [!IMPORTANT]
> Owner: scene identity, hierarchy, and world-space propagation. This package is the sole authority for `Transform`, `ChildOf`, `Children`, `Name`, and `scenePlugin`.

## Smallest useful example

```ts
import { scenePlugin, Transform } from '@forgeax/engine-scene';
import { World } from '@forgeax/engine-ecs';

const world = new World();
const plugin = scenePlugin();
await plugin.build(world);
const entity = world.spawn({ component: Transform, data: {} }).unwrap();
void entity;
```

`scenePlugin()` registers hierarchy propagation. Read failures as `SceneError` and branch on `error.code`; do not parse messages.

The authority also applies to dynamic loading: import `Transform`, `ChildOf`, and `scenePlugin` from `@forgeax/engine-scene` when a host resolves packages at runtime.

## Boundary

| This package owns | Excluded concepts |
|:--|:--|
| Identity, parent/child links, local/world transforms | Meshes, materials, cameras, skins, animation, GPU/RHI |

See [`src/index.ts`](src/index.ts) for the public roster and [`src/errors.ts`](src/errors.ts) for recovery details.

## Visibility hierarchy boundary

Quick start: create `ChildOf` links through the scene package, then let
`resolveVisibility(world)` consume the projected hierarchy when a render or
remote diagnostic asks for an effective state.

| Fact | Scene owns | Consumer owns |
|:--|:--|:--|
| Parent relation | `ChildOf`, `Children`, and hierarchy projection | Visibility intent and render filtering |
| Effective lookup | Valid parent traversal and hierarchy diagnostics | `Visibility` field values and renderer statistics |
| Recovery | Repair a stale/cyclic relation from `SceneHierarchyDiagnostic` | Do not reinterpret a hierarchy error as a camera or picking error |

Read `VisibilityResolution.source` to distinguish `self`, `parent`, and the
default root case. If diagnostics report an invalid hierarchy, fix the scene
relation and resolve again; do not add a render-only parent or bypass the
scene graph. Camera, picking, lifecycle, assets, and VFX shadow behavior are
out of scope for this package.

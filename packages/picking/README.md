# @forgeax/engine-picking

Screen-to-entity, vertex-level, and tile-cell picking as free functions. Tier 2.2
package extracted from `@forgeax/engine-runtime`
(feat-20260705-runtime-tier2-decomposition M2) so an AI user loads only the
picking concept surface — not the whole renderer — when the task is "turn a
screen coordinate into an entity / vertex / tile". First runtime-downstream
engine package: `@forgeax/engine-picking` depends on `@forgeax/engine-runtime`,
never the reverse.

## 30-second self-introduction

- **`pick(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)`**
  — unprojects a viewport-relative screen coordinate into a world-space ray
  through the camera, walks every renderable archetype, ray-AABB tests each
  pickable mesh's world-space bounding box, and returns the nearest
  `PickHit { entity, point, distance }` (or `undefined` on a miss). AABB
  granularity (Three.js `Raycaster`-aligned MVP; per-triangle precision is
  `pickVertex`).
- **`pickVertexOnEntity` / `pickVertex`** — per-triangle vertex-level queries
  (editor vertex-snapping workflow). Three-state static-dispatch overload:
  without options -> `VertexHit | undefined`; with `{ limit: N }` -> `VertexHit[]`
  sorted by `screenDist`. `pickVertexOnEntity` queries one entity; `pickVertex`
  walks the whole scene (AABB coarse cull, then per-entity vertex collect).
- **`pickTile(world, tilemapEntity, worldX, worldY)`** — cell-level Tilemap query:
  converts world coordinates to the tilemap's local cell grid, walks child
  `TileLayer`s in descending `layerOrder`, and returns
  `Result.ok(PickTileHit { layerEntity, cellX, cellY, tileId })` for the topmost
  non-zero cell, `Result.ok(null)` for empty / out-of-bounds, or
  `Result.err(PickTileError)` for a structural break.
- **`PickError` / `PickErrorCode`** — closed single-member error union
  (`'camera-component-missing'`); the SSOT for the picking error surface. A
  `cameraEntity` without a `Camera` component throws `PickError`; ordinary "ray
  hit nothing" outcomes return `undefined` / `[]` (error channel physically
  separated from the miss channel, charter P3).
- **`pick-core`** (internal) — the shared skeleton (camera validation ->
  `view = invert(Transform.world)` -> projection branch -> `screenToRay` ->
  `readWorldMatrix`) that `pick` and `pickVertex*` both consume. Single source of
  truth (architecture-principles §2); the AI user never imports it directly.

### 30s hands-on example

```ts
import { pick, type PickHit } from '@forgeax/engine-picking';
import { MeshRenderer, propagateTransforms } from '@forgeax/engine-runtime';

// Caller resolves Transform.world for the current frame first (D-9 contract):
propagateTransforms(world);

const hit: PickHit | undefined = pick(
  world,
  cameraEntity,
  pointerX, pointerY,        // viewport-relative, y-down, top-left origin
  canvas.width, canvas.height,
);
if (hit) {
  // hit.entity: the picked EntityHandle; hit.point: world-space AABB entry;
  // hit.distance: entry distance along the ray (>= 0)
  world.set(hit.entity, MeshRenderer, { materials: [highlight] });
}
```

## API surface

### Screen-to-entity (`pick`)

| Function | Signature | Return |
|:--|:--|:--|
| `pick` | `(world, cameraEntity, screenX, screenY, viewportWidth, viewportHeight)` | `PickHit \| undefined` (nearest hit, or `undefined` on miss) |

`PickHit = { entity: EntityHandle; point: Vec3Like; distance: number }`. No
`face` / `uv` / `normal` — AABB picking has no triangle resolution, so those
would be a lie (use `pickVertex` for per-triangle vertices). Both `perspective`
and `orthographic` camera projections are supported. Reads the resolved
`Transform.world` mat4 directly (feat-20260601 D-3), so the camera + candidates
must have propagated transforms for the current frame.

### Vertex-level (`pickVertex` / `pickVertexOnEntity`)

| Function | Signature | Return |
|:--|:--|:--|
| `pickVertexOnEntity` | `(world, cameraEntity, screenX, screenY, vpW, vpH, entity, options?)` | Without `options`: `VertexHit \| undefined` |
| `pickVertexOnEntity` | `(..., entity, { limit })` | `VertexHit[]` (sorted by `screenDist` asc, empty on miss) |
| `pickVertex` | `(world, cameraEntity, screenX, screenY, vpW, vpH, options?)` | Without `options`: `VertexHit \| undefined` |
| `pickVertex` | `(..., { limit })` | `VertexHit[]` (globally sorted by `screenDist` asc, empty on miss) |

`VertexHit = { entity, vertexIndex, worldPos: Vec3Like, screenDist, worldDist, deformed }`.
Only `triangle-list` submeshes participate; skinned meshes report
`deformed=true` with rest-pose `worldPos`. Behind-camera vertices are excluded.

> [!IMPORTANT]
> **`propagateTransforms` precondition (D-9)** — call
> `propagateTransforms(world)` (exported from `@forgeax/engine-runtime`) for the
> current frame before `pick` / `pickVertex*`. These functions read
> `Transform.world` column-major mat4 directly; they never re-propagate. The
> contract is identical across `pick` and `pickVertex*`.

### Tile-cell (`pickTile`)

| Function | Signature | Return |
|:--|:--|:--|
| `pickTile` | `(world, tilemapEntity, worldX, worldY)` | `Result<PickTileHit \| null, PickTileError>` |

`PickTileHit = { layerEntity, cellX, cellY, tileId }`. `Result.ok(null)` = empty
cell or out-of-bounds; `Result.err` only for structural breaks (entity carries
no `Tilemap`). `PickTileError` is a closed two-member discriminated union
(`'tilemap-not-found'` / `'tilemap-component-missing'`), runtime-local (not
exported through `@forgeax/engine-types`).

## Error model (SSOT)

`PickErrorCode` is this package's error-code SSOT (per AGENTS.md §Error model,
`grep 'export type [A-Z]\w+ErrorCode'`):

| `PickError.code` | Trigger | Semantics |
|:--|:--|:--|
| `'camera-component-missing'` | the `cameraEntity` passed to `pick` / `pickVertex*` holds no `Camera` component | unrecoverable precondition — no view/projection matrix can be built; carries `.expected` / `.hint` / `.detail.cameraEntity` |

Closed single-member union (minor add-only per the AGENTS.md evolution contract);
AI users perform exhaustive `switch (err.code)` without a `default` (TS guards
completeness — see `src/__tests__/pick-errors.test-d.ts`). `PickTileError` is the
second closed union, returned (not thrown) via `Result`.

## Package boundary

Depends on `@forgeax/engine-runtime` (components: `Camera` / `Transform` /
`MeshFilter` / `MeshRenderer` / `ChildOf` / `TileLayer` / `Tilemap`;
`propagateTransforms`), `@forgeax/engine-assets-runtime` (`resolveAssetHandle`
for `MeshAsset.aabb`), `@forgeax/engine-ecs`, `@forgeax/engine-math`, and
`@forgeax/engine-types`. `@forgeax/engine-runtime` does **not** import this
package (no reverse edge — picking is a leaf consumer).

Visible acceptance: `apps/hello/picking` (click a cube to highlight) +
structural-only dawn-node smoke (asserts `pick` returns the expected entity + a
miss returns `undefined`).

## Source anchors

- `src/pick.ts` — `pick` + `PickHit`
- `src/pick-vertex.ts` — `pickVertex` / `pickVertexOnEntity` + `VertexHit`
- `src/pick-tile.ts` — `pickTile` + `PickTileHit` / `PickTileError`
- `src/pick-errors.ts` — `PickError` / `PickErrorCode` (error SSOT)
- `src/pick-core.ts` — shared camera->ray skeleton (internal)

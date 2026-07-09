# @forgeax/engine-assets-runtime

The runtime asset layer: catalogue an asset by GUID, load its payload + all
transitively-referenced sub-assets, resolve a `Handle` back to its payload, and
wire the default loader set. Tier 2.1 package extracted from
`@forgeax/engine-runtime` (feat-20260705-runtime-tier2-decomposition M1) so an AI
user loads only the asset-cluster concept surface — not the whole renderer — when
the task is "get an asset into the World".

## 30-second self-introduction

- **`AssetRegistry`** — instance-per-engine GUID -> payload catalogue. `catalog` /
  `loadByGuid` / `lookup` / `parseGuid` / `inspect` / `resolveName` / `packageOf` /
  `rename` / `invalidate` / `invalidateAll` / `instantiate`. Post-D-17 it stores
  the PAYLOAD and mints no handles (column handles are minted on the World via
  `world.allocSharedRef('Kind', payload)`). `Renderer.assets` is an `AssetRegistry`
  assembled by `createRenderer` (which injects the post-spawn hook + audio/video
  loaders — see D-1 / D-2).
- **`HANDLE_CUBE` / `HANDLE_TRIANGLE` / `HANDLE_QUAD` / `HANDLE_SPHERE` /
  `HANDLE_CYLINDER` / `HANDLE_NINESLICE_QUAD`** — process-static builtin mesh
  handles (reserved ids 1-6, `< BUILTIN_BASE`), resolved through
  `BuiltinAssetRegistry` (never reference-counted). Pair with `MeshFilter`.
- **`resolveAssetHandle(world, handle)`** — two-tier (builtin / user-tier
  `world.sharedRefs`) handle -> payload resolution; returns a closed-union error
  (`shared-ref-stale` / `shared-ref-released` / `asset-not-found`) so callers
  distinguish "re-acquire handle" from "re-load asset" from "check GUID".
- **`LoaderRegistry` + `wireDefaultLoaders(registry, extraLoaders?)` +
  `createDefaultLoaderRegistry(extraLoaders?)`** — the default set is the 9
  engine-owned loader kinds (6 inline pack-payload + texture/font/equirect);
  `extraLoaders` (audio placeholder + video loader) are injected by
  `createRenderer` to complete the 11-kind set (D-2).

### 30s hands-on example

```ts
import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { MeshFilter, MeshRenderer, Transform } from '@forgeax/engine-runtime';

// A builtin mesh handle needs no registration ceremony:
world.spawn(
  { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
  { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
  { component: MeshRenderer, data: { materials: [matHandle] } },
).unwrap();

// Catalogue + load a GUID-addressed asset (dev / inline path):
const guid = assets.parseGuid('cbe42beb-8975-5096-b3a1-3dda4cb4c077');
const res = await assets.loadByGuid(guid); // -> Result<payload> (D-17: payload, not handle)
```

## API surface

| Symbol | Kind | One-line |
|:--|:--|:--|
| `AssetRegistry` | class | GUID -> payload catalogue + loader dispatch + scene instantiate |
| `HANDLE_CUBE` / `HANDLE_TRIANGLE` / `HANDLE_QUAD` / `HANDLE_SPHERE` / `HANDLE_CYLINDER` / `HANDLE_NINESLICE_QUAD` | const | builtin mesh handles (ids 1-6) |
| `BuiltinAssetRegistry` / `BUILTIN_*` / `BUILTIN_FLOATS_PER_VERTEX` / `BUILTIN_BASE` | const | process-static builtin payloads + vertex-layout SSOT |
| `resolveAssetHandle` / `walkMaterialPassesOverSharedRefs` | fn | two-tier handle -> payload resolution |
| `LoaderRegistry` | class | kind -> loader dispatch table |
| `wireDefaultLoaders` / `createDefaultLoaderRegistry` | fn | wire the 9 engine loaders + caller `extraLoaders` |
| `DynamicTextureStore` / `DynamicTextureDevice` | class/type | per-frame dynamic texture upload store |
| `unpackMeshBin` / `UnpackedMeshBin` | fn/type | `<guid>.bin` sidecar decode |
| `validateTilesetPayload` / `TilesetValidateOptions` | fn/type | register-time tileset payload gate |
| `PostSpawnHook` / `SkinJointResolver` | type | post-spawn hook contract (D-1; runtime injects `postSpawnResolveJoints`) |
| `Asset` / `MeshAsset` | type | re-exported asset union shapes (SSOT `@forgeax/engine-types`) |

Full `AssetRegistry` surface + signatures: source SSOT
`packages/assets-runtime/src/asset-registry.ts`. The load + DDC / pack-fetch
pipeline lives in `packages/assets-runtime/src/registry/load-by-guid.ts`; the
instantiate cluster + hook types in `registry/instantiate.ts`; material
validation in `registry/validate-material.ts`.

## Error model

`AssetRuntimeErrorCode` is the package's closed error-code SSOT (exhaustive
`switch (err.code)` without `default`; TS guards completeness). Read the source,
don't duplicate the member list — `packages/assets-runtime/src/errors/asset.ts`
(grep `export type AssetRuntimeErrorCode`). Members today:
`material-resolved-empty-passes` / `mesh-ssbo-capacity-exceeded` /
`mesh-ssbo-ceiling-reached` / `scene-collect-entity-ref-out-of-closure` /
`scene-collect-asset-guid-unresolved`. Each error object carries
`.code` / `.expected` / `.hint` / `.detail`. `RendererError` (in
`@forgeax/engine-runtime`) composes `AssetRuntimeError` into its onError fan-out
union, so a dropped arm is a compile error.

## Dependencies

`@forgeax/engine-{codec, ecs, geometry, pack, rhi, shader, types}` only. Never
imports `@forgeax/engine-runtime` (the dependency direction is runtime ->
assets-runtime; the post-spawn hook + audio/video loaders are injected downward
at the `createRenderer` assembly point, D-1 / D-2).

## Route map

- Import images / glTF / fonts, wire `loadByGuid`, author sidecars: skill
  `forgeax-engine-assets`.
- Full asset-chain narrative (sidecar -> import -> pack-index -> loadByGuid):
  `packages/pack/README.md` + `forgeax-engine-assets/README.md`.

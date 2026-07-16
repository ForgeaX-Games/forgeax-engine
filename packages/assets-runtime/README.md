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
  assembled by `createRenderer` (which injects the post-spawn hook and concrete
  Web Audio loader; video is a default loader — see D-1 / D-2).
- **`HANDLE_CUBE` / `HANDLE_TRIANGLE` / `HANDLE_QUAD` / `HANDLE_SPHERE` /
  `HANDLE_CYLINDER` / `HANDLE_NINESLICE_QUAD`** — process-static builtin mesh
  handles (reserved ids 1-6, `< BUILTIN_BASE`), resolved through
  `BuiltinAssetRegistry` (never reference-counted). Pair with `MeshFilter`.
- **`resolveAssetHandle(world, handle)`** — two-tier (builtin / user-tier
  `world.sharedRefs`) handle -> payload resolution; returns a closed-union error
  (`shared-ref-stale` / `shared-ref-released` / `asset-not-found`) so callers
  distinguish "re-acquire handle" from "re-load asset" from "check GUID".
- **`LoaderRegistry` + `wireDefaultLoaders(registry, extraLoaders?)` +
  `createDefaultLoaderRegistry(extraLoaders?)`** — the default set is 10
  engine-owned kinds (6 inline pack-payload + texture/font/equirect + video).
  `createRenderer` injects the concrete Web Audio catalog-entry loader as the
  eleventh kind, keeping this package independent of the audio backend.

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
| `wireDefaultLoaders` / `createDefaultLoaderRegistry` | fn | wire 10 engine loaders + caller `extraLoaders` |
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

`@forgeax/engine-{codec, ecs, geometry, graphics-extras, image, pack, rhi, shader, types}`.
Never imports `@forgeax/engine-runtime` or an audio backend: runtime injects the
post-spawn hook and concrete audio catalog-entry loader at `createRenderer`.

## Runtime image bytes decoder (`decodeImageBytes`)

`decodeImageBytes(bytes, mime, opts?)` is the runtime SDK entry for AI users
who already hold image bytes in memory (fetched from a URL, embedded as
base64, produced by an out-of-tree decoder, etc.) and want to feed them into
`world.allocSharedRef('TextureAsset', pod)` + `GpuResourceStore.ensureResident`
without the disk-side importer / pack build pipeline in the loop. It is the
runtime counterpart to the build-time `.bin` / `.ktx2` texture loaders --
those stay authoritative for shipped assets; `decodeImageBytes` covers the
"bytes only exist at runtime" case that static loaders cannot serve
(tweak-20260714).

### Signature

```ts
export async function decodeImageBytes(
  bytes: Uint8Array | ArrayBuffer,
  mime: string,
  opts?: { colorSpace?: 'srgb' | 'linear'; mipmap?: boolean },
): Promise<Result<TextureAsset, ImageError>>;
```

- `bytes` -- encoded image byte stream (PNG or JPEG). Both `Uint8Array` and
  `ArrayBuffer` accepted; the function does not take ownership.
- `mime` -- byte-stream mime type. v1 whitelist: `'image/png' | 'image/jpeg'`
  (see boundaries below).
- `opts.colorSpace` -- `'srgb'` (default) or `'linear'`. Derives POD `format`:
  `srgb -> 'rgba8unorm-srgb'`, `linear -> 'rgba8unorm'` (mirrors the
  build-time `packages/image/src/image-importer.ts` `colorSpaceToFormat`
  rule -- one SSOT, no drift).
- `opts.mipmap` -- `true` (default) or `false`. When `true`, `mipLevelCount`
  is computed by the existing `numMipLevels({ width, height })`; when
  `false`, `mipLevelCount === 1`.

### v1 boundaries (explicit non-goals)

The function is intentionally a thin bridge from bytes to a `TextureAsset`
POD. What it does NOT do:

- **No network I/O.** `decodeImageBytes` never `fetch`es; the caller supplies
  bytes.
- **No GPU upload.** The POD is fed into the existing
  `world.allocSharedRef('TextureAsset', pod)` +
  `GpuResourceStore.ensureResident` path -- the upload primitives are not
  duplicated or replaced.
- **v1 supports PNG / JPEG only.** GIF / WebP / SVG / AVIF / KTX2 / HDR
  (`.hdr`) fall to `image-format-unsupported`; convert offline (or
  reach for the build-time importer, which handles a wider set) rather
  than expanding this API's mime table.
- **Not a replacement for the static texture loader.** Shipped `.bin` /
  `.ktx2` continue to flow through the pack pipeline (`loadByGuid`); this
  API only covers the runtime-only-bytes case (progressive disclosure --
  AI user sees the smaller, more focused surface).
- **Not a Node / server-side decoder.** Requires an environment with
  `createImageBitmap` + `OffscreenCanvas` (browser main thread or Worker).
  Missing capability surfaces as a structured `image-decode-failed` error
  (never a silent broken POD).

### Error codes (closed union subset)

`decodeImageBytes` only ever produces the four base `ImageErrorCode` members
listed here; the other atlas / HDR members of the union are not reachable
from this API. Every error object carries `.code` / `.expected` /
`.hint` / `.detail`; `.detail` narrows per `.code` (discriminated union).
Read the source, do not duplicate the member list --
`packages/types/src/index.ts` (grep `export type ImageErrorCode`).

| code | trigger | `.detail` narrows to |
|:--|:--|:--|
| `image-format-unsupported` | mime not in `['image/png', 'image/jpeg']` | `{ actualMime, path?, formatColorSpaceConflict? }` |
| `image-decode-failed` | decoder rejected bytes, or env lacks `createImageBitmap` | `{ reason, path? }` |
| `image-dimension-out-of-bounds` | reserved; transparent pass-through if the underlying decoder ever surfaces it | `{ requested: {width,height}, limit }` |
| `image-meta-missing` | reserved; not raised by this API in v1 (kept in the union for a single grep-discoverable SSOT) | `{ sourcePath, expectedSidecarPath }` |

### Error self-recovery paradigm

Structured errors with copy-pastable hints -- AI users consume via property
access, never by parsing `.message` (charter P3 explicit failure + P4
consistent abstraction; AGENTS.md Error model). Exhaustive `switch
(err.code)` needs no `default` -- TypeScript guards union completeness at
compile time, so future minor adds to `ImageErrorCode` surface as a
localised type error rather than a silent miss.

```ts
import { decodeImageBytes } from '@forgeax/engine-assets-runtime';

const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
const result = await decodeImageBytes(bytes, 'image/png');
if (!result.ok) {
  const err = result.error;
  // .hint carries an executable recovery instruction (see IMAGE_ERROR_HINTS
  // SSOT in packages/types/src/index.ts); no string parsing needed.
  console.error(err.code, err.hint);
  // NOTE: switch on `err.detail.code`, not `err.code`. `ImageError` carries
  // two independent discriminants (`.code` on the envelope, `.code` on the
  // `.detail` variant); TS does not cross-narrow between them, so per-arm
  // access to `err.detail.<field>` only compiles when the switch scrutinee
  // is the same discriminant as the union being narrowed.
  switch (err.detail.code) {
    case 'image-format-unsupported':
      // err.detail.actualMime -- rejected mime; convert offline
      console.error('bad mime:', err.detail.actualMime);
      break;
    case 'image-decode-failed':
      // err.detail.reason -- underlying decoder message (or "env lacks
      // createImageBitmap" when the platform capability is missing)
      console.error('decode reason:', err.detail.reason);
      break;
    case 'image-dimension-out-of-bounds':
      console.error('too big:', err.detail.requested, err.detail.limit);
      break;
    case 'image-meta-missing':
      console.error('missing sidecar:', err.detail.expectedSidecarPath);
      break;
  }
  return;
}

// Bytes in, POD out -- charter P4 one abstraction, same POD shape as the
// build-time texture loader emits, so downstream does not care about the
// byte source (progressive disclosure: allocSharedRef + ensureResident is
// the same call site as static assets).
const handle = world.allocSharedRef('TextureAsset', result.value);
```

### Isolation gate boundary

`decode-image-bytes.ts` is the SINGLE file in `@forgeax/engine-assets-runtime`
allowed to statically import `@forgeax/engine-image`. The
`scripts/check-image-pipeline-isolation.mjs` (a.2-anti) rule pins this
exact path as its whitelist; the wider runtime and the rest of
assets-runtime remain gated so a future accidental static import falls
loud, not silent.

## Route map

- Import images / glTF / fonts, wire `loadByGuid`, author sidecars: skill
  `forgeax-engine-assets`.
- Full asset-chain narrative (sidecar -> import -> pack-index -> loadByGuid):
  `packages/pack/README.md` + `forgeax-engine-assets/README.md`.
- Runtime image bytes decoding (this package, runtime-only-bytes case):
  see the `decodeImageBytes` section above.

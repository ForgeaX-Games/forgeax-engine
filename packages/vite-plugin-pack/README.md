// @forgeax/engine-vite-plugin-pack
// Vite plugin for the forgeax engine asset package system.
// Dev mode: HMR + /__pack/lookup/:guid + /__pack/index routes.
// Build mode: generateBundle scans roots, imports each `kind: 'texture'` row
// (parseImage -> raw RGBA bytes -> emitFile hashed `<guid>-[hash].bin`),
// rewrites `relativeUrl` to the hashed path, and emits `pack-index.json`.

# Pack-index entry shape (5 fields, SSOT: `PackIndexEntry` in `@forgeax/engine-types`)

Each row in `pack-index.json` (build) or `/__pack/index` (dev) carries:

| Field | Type | Notes |
|:--|:--|:--|
| `guid` | `string` (UUIDv5/v7 lowercase) | asset identity |
| `relativeUrl` | `string` | dev: source-relative path (e.g. `/assets/wood-container.jpg`); build: hashed import artefact (e.g. `/assets/<guid>-[hash].bin`) |
| `kind` | `string` (closed disc.) | `'texture'` / `'mesh'` / `'scene'` / `'material'` / future arms |
| `sourcePath` | `string` | on-disk source path (debugging + grep; build retains source JPG path even though `relativeUrl` points to import artefact) |
| `metadata` | `ImageMetadata \| undefined` | present iff `kind === 'texture'`; sub-structure: `width?` / `height?` / `format: GPUTextureFormat` / `colorSpace: 'srgb' \| 'linear'` / `mipmap: boolean`; `width` / `height` may be absent in dev-mode entries pre-decode (build-mode import fills them) |

`metadata.mipmap` is the boolean form; sidecar `*.meta.json` `importSettings.mipmap` string tokens `'auto'` / `'none'` are mapped at the catalog builder (feat-20260517-vite-plugin-image-build-time-cook D-5; runtime is unaware of the string form). 5-field shape is feat-20260517-vite-plugin-image-build-time-cook D-2 (charter P4 consistent abstraction; metadata field names mirror `TextureAsset` POD byte-for-byte).

# Dev import pairing contract (AC-14)

> [!IMPORTANT]
> Dev-mode lazy import (import-on-demand) needs **two** wirings that come as a pair. Provide one without the other and dev `loadByGuid` of an un-imported texture fails. They live on opposite sides of the dev boundary, so each is easy to forget.

| Side | Wiring | Symptom if omitted |
|:--|:--|:--|
| **plugin** (`vite.config.ts`) | `pluginPack({ roots, importers: [imageImporter] })` | dev `POST /__import` has an empty `ImporterRegistry` -> `422 importer-not-registered`; nothing is ever imported |
| **client** (app host) | inject `createDevImportTransport()` into `createApp` / `createRenderer` | the studio form has no transport, so import-on-demand degrades to the shipped fail-fast: `loadByGuid` returns `asset-not-imported` and the frame stays black |

## Layer 1 -- wire the dev transport in one line each

```ts
// vite.config.ts (plugin side)
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { pluginPack } from '@forgeax/engine-vite-plugin-pack';

export default defineConfig({
  plugins: [pluginPack({ roots: ['assets'], importers: [imageImporter] })],
});
```

```ts
// app host (client side)
import { createApp, createDevImportTransport } from '@forgeax/engine-runtime';

const app = await createApp(canvas, options, { importTransport: createDevImportTransport() });
```

## Layer 2 -- what the pair does on a DDC miss

A dev catalog keeps a **discoverable raw-source texture row** for any asset that has only a `*.meta.json` (no build-imported `.bin`). When `loadByGuid` resolves that row, the runtime loader sees a non-`.bin` `relativeUrl` and returns the `AssetErrorCode` sentinel `texture-source-not-imported` (an `AssetError`). `loadByGuidProd` treats that sentinel as transport-eligible and calls the injected transport's `fetchPack(guid)`, which `POST`s `/__import/<guid>`. The dev server imports the source to an `rgba16float` / `rgba8` `.bin` via the shared `importTextureEntry` SSOT, rebuilds the catalog so the same-GUID row now ends `.bin`, and returns the fresh `PackIndexEntry[]`; the loader clears its cache and re-enters, reading the imported `.bin`. HDR equirect sources (`*.hdr` declared as a `cube-texture` sub-asset) ride the same path: the dev `POST /__import` tolerates the runner's `import-produced-no-assets` and still imports the `.hdr` to a 2D `rgba16float` `.bin` (the GPU cube-isation stays in `uploadCubemapFromEquirect`).

## Layer 3 -- shipped form fails fast; build is untouched

Without an injected transport (shipped form), the same sentinel surfaces as `asset-not-imported` -- a fail-fast, never a silent lazy import. A genuinely corrupt imported `.bin` is a different signal entirely: it is the `ImageError` `image-decode-failed` and is **never** transport-eligible (the eligibility guard is `instanceof AssetError`), so a real decode failure is never re-fetched. The build path is also unaffected: `generateBundle` pre-imports every texture row (incl. `.hdr`) to a hashed `.bin` ahead of its own pre-import pass, so the shipped bundle carries the `.bin` directly and never exercises the dev `POST /__import` arm.

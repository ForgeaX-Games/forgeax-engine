# @forgeax/engine-graphics-extras

Pure-logic modules for text glyph layout, tilemap bit encoding, and video
playback. System entry points (`tilemapChunkExtractSystem`,
`glyphTextLayoutSystem`) remain in `@forgeax/engine-runtime` -- see the package
boundary declaration below. A **near-leaf** package: depends only on
`@forgeax/engine-ecs` (`defineComponent` / `EntityHandle`), `@forgeax/engine-rhi`
(`Result`), and `@forgeax/engine-types` (`FontAsset` / `MeshAsset` / `Loader` /
`Handle` / `VideoAsset`). It never imports the renderer or `@forgeax/engine-runtime`
(AC-301: zero back-reference to runtime).

## 30-second self-introduction

- **Surface**: three pure-logic clusters extracted from runtime (Tier 2.3):
  - **glyph** -- `layoutGlyphText` / `bakeGlyphMesh` / `buildGlyphMeshAsset` +
    the layout POD types (`GlyphLayoutResult` / `GlyphMeshBakeResult`), stride
    constants (`FloatsPerGlyphVertex` / `VERTEX_OFFSET`), and the per-frame
    font-concurrency tracker (`FONT_CONCURRENCY_LIMIT` / `resetFontConcurrency` /
    `trackFontConcurrency`) + `conservativeCubeAabb`.
  - **tile-bits** -- `encodeTileBits` / `decodeTileBits`, the packed-tile bit
    codec SSOT (tileId + flipH/flipV/flipDiagonal flags in one `u32`).
  - **video** -- the `VideoPlayer` component, the `VideoElementProvider` host
    bridge (`VIDEO_ELEMENT_PROVIDER_KEY` + interface), the `videoLoader`
    (`Loader<VideoAsset>`), and the `probeVideoHighPerfUpload` capability probe
    (`VideoCapabilityDevice`).
- **Style**: pure functions + POD component/resource definitions -- no renderer,
  no GPU device, no DOM construction. `videoLoader` and `VideoElementProvider`
  describe host-supplied `HTMLVideoElement` bridging; the package never
  constructs a `<video>` element or touches the DOM.
- **Errors**: `layoutGlyphText` returns `Result<GlyphLayoutResult, TextError>`
  (`TextError` union owned by `@forgeax/engine-types`); the font-concurrency
  limit surfaces `TextError('font-concurrency-exceeded')` at the system-entry
  layer, not here. This package declares no `*ErrorCode` union of its own.

### 30s hands-on example

```ts
// glyph: lay out + bake a text label into an unregistered MeshAsset POD
import { layoutGlyphText, bakeGlyphMesh } from '@forgeax/engine-graphics-extras';

// tile-bits: pack a tile id + flip flags into a single u32 cell value
import { encodeTileBits, decodeTileBits } from '@forgeax/engine-graphics-extras';
const cell = encodeTileBits(/* tileId */ 5, /* flipH */ true, false, false, false);
const { tileId, flipH } = decodeTileBits(cell); // { tileId: 5, flipH: true, ... }

// video: spawn a VideoPlayer entity + register the host element provider
import {
  VideoPlayer,
  VIDEO_ELEMENT_PROVIDER_KEY,
  type VideoElementProvider,
} from '@forgeax/engine-graphics-extras';
```

## Package boundary declaration

This package contains **only** pure-logic files with zero `@forgeax/engine-runtime`
component dependencies (research F14 verified all 7 files are clean pure-logic).

**System entry points that deeply couple with runtime's component system are NOT
here -- they stay in `@forgeax/engine-runtime` and import from this package via
cross-package import:**

- `tilemap-chunk-extract-system.ts` (1,150 lines) -- walks `Tilemap` / `TileLayer`
  / `ChildOf` archetypes, spawns per-cell derived entities carrying `MeshFilter`
  (`HANDLE_QUAD`) / `MeshRenderer` / `Transform`. Consumes `decodeTileBits` from
  this package.
- `glyph-text-layout-system.ts` (375 lines) -- walks `GlyphText` entities,
  attaches `MeshFilter` / `MeshRenderer`, and drives the per-frame bake cache.
  Consumes `layoutGlyphText` / `bakeGlyphMesh` / `resetFontConcurrency` /
  `trackFontConcurrency` from this package.
- the per-frame video upload path in `record/main-pass.ts` +
  `record/main-pass-material.ts` -- consumes `probeVideoHighPerfUpload` /
  `VIDEO_ELEMENT_PROVIDER_KEY` / `VideoElementProvider` from this package.

Reading this section means an AI user knows **why `tilemapChunkExtractSystem` is
not in this package** without a full-repo grep: it depends on runtime's ECS
component roster, which would create a back-edge to runtime and violate AC-301.

`videoLoader` flows the other way -- `@forgeax/engine-assets-runtime`'s
`wire-default-loaders` statically imports it from here (forward edge
graphics-extras -> assets-runtime; the CI build order places graphics-extras
before assets-runtime).

## Shrinkage honesty declaration (AC-304)

This package migrates **7 files (~633 lines)** from `@forgeax/engine-runtime`:

| file | lines |
|:--|--:|
| `glyph-layout.ts` | 210 |
| `glyph-mesh-bake.ts` | 140 |
| `tile-bits.ts` | 77 |
| `video-element-provider.ts` | 72 |
| `video-player-system.ts` | 61 |
| `video-player.ts` | 49 |
| `video-loader.ts` | 24 |
| **total** | **633** |

The original runtime-decomposition roadmap estimated **~2.1k lines** for Tier 2.3
(tilemap 1,170 + text 717 + video 206). The difference (~1.5k lines) is the two
system-entry files -- `tilemap-chunk-extract-system.ts` (1,150 lines) and
`glyph-text-layout-system.ts` (375 lines) -- that deeply couple with runtime's
component system and are directly invoked by `createRenderer` / the per-frame
render walk. Per the human decision recorded in requirements Q2 ("modules that
depend on runtime components stay in runtime"), only the pure-logic modules are
extracted. The honest migrated size is 633 lines, not the roadmap's 2.1k estimate
(charter F4 honesty axiom -- the same discipline as the Tier 1 `file_count`
axiom declaration; this package does not overstate the slimming it delivers).

## API surface

### glyph (from `glyph-layout.ts` + `glyph-mesh-bake.ts`)

| Symbol | Kind | Notes |
|:--|:--|:--|
| `layoutGlyphText(font, text, fontSize)` | function | `Result<GlyphLayoutResult, TextError>`; pure layout, no GPU |
| `bakeGlyphMesh(world, layout)` | function | bakes a `GlyphLayoutResult` into a `MeshAsset` |
| `buildGlyphMeshAsset(layout)` | function | `MeshAsset` builder used by `bakeGlyphMesh` |
| `conservativeCubeAabb(radius)` | function | `Float32Array` local AABB helper |
| `GlyphLayoutResult` / `GlyphMeshBakeResult` | interface | layout / bake POD result types |
| `FloatsPerGlyphVertex` (12) / `VERTEX_OFFSET` | const | interleaved vertex stride SSOT |
| `FONT_CONCURRENCY_LIMIT` (8) | const | per-frame distinct-font cap |
| `resetFontConcurrency()` / `trackFontConcurrency(fontId)` | function | per-frame font-concurrency tracker |

### tile-bits (from `tile-bits.ts`)

| Symbol | Kind | Notes |
|:--|:--|:--|
| `encodeTileBits(tileId, flipH, flipV, flipDiagonal, ...)` | function | packs a tile cell into a `u32` |
| `decodeTileBits(packed)` | function | `{ tileId, flipH, flipV, flipDiagonal }` |

### video (from `video-player.ts` + `video-player-system.ts` + `video-element-provider.ts` + `video-loader.ts`)

| Symbol | Kind | Notes |
|:--|:--|:--|
| `VideoPlayer` | component | `defineComponent('VideoPlayer', ...)`; clip / playing / loop / `currentTime` (field-level `transient: true`, feat-20260709 -- per-frame playback head derived from the `HTMLVideoElement`, excluded from scene collect/serialization) |
| `VIDEO_ELEMENT_PROVIDER_KEY` | const | World Resource key for the host bridge |
| `VideoElementProvider` | interface | host returns an `HTMLVideoElement` per entity + clip |
| `videoLoader` | const | `Loader<VideoAsset>`; wired by assets-runtime defaults |
| `probeVideoHighPerfUpload(device)` | function | AC-09 capability probe |
| `VideoCapabilityDevice` | interface | minimal device shape the probe reads |

### Error codes

This package declares **no** `*ErrorCode` union. `layoutGlyphText` returns a
`TextError` whose closed union is owned by `@forgeax/engine-types` (read
`packages/types/src/errors` / grep `export type TextErrorCode`). `VideoPlayer` is
a component, not an error carrier.

## Source anchors

- glyph layout + stride SSOT -- `src/glyph-layout.ts`
- glyph mesh bake -- `src/glyph-mesh-bake.ts`
- tile-bit codec -- `src/tile-bits.ts`
- video component / host bridge / loader / probe -- `src/video-player.ts`,
  `src/video-element-provider.ts`, `src/video-loader.ts`, `src/video-player-system.ts`

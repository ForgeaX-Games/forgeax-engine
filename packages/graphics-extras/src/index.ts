// @forgeax/engine-graphics-extras -- public barrel.
//
// feat-20260705-runtime-tier2-decomposition M3: pure-logic graphics-adjacent
// modules extracted from @forgeax/engine-runtime. System entry points
// (tilemapChunkExtractSystem / glyphTextLayoutSystem) stay in runtime and
// import from here -- see README.md for the package boundary declaration.

// ─── glyph text layout (feat-20260531-world-space-msdf-text-rendering) ─────
export {
  FloatsPerGlyphVertex,
  FONT_CONCURRENCY_LIMIT,
  type GlyphLayoutResult,
  layoutGlyphText,
  resetFontConcurrency,
  trackFontConcurrency,
  VERTEX_OFFSET,
} from './glyph-layout';
export {
  bakeGlyphMesh,
  buildGlyphMeshAsset,
  conservativeCubeAabb,
  type GlyphMeshBakeResult,
} from './glyph-mesh-bake';

// ─── tile-bits SSOT (feat-20260608-tilemap-object-layer-rendering) ─────────
export { decodeTileBits, encodeTileBits } from './tile-bits';

// ─── VideoElementProvider host bridge ─────────────────────────────────────
export {
  VIDEO_ELEMENT_PROVIDER_KEY,
  type VideoElementProvider,
} from './video-element-provider';
export { videoLoader } from './video-loader';
// ─── VideoPlayer component ────────────────────────────────────────────────
export { VideoPlayer } from './video-player';
// ─── video high-perf upload capability probe ──────────────────────────────
export { probeVideoHighPerfUpload, type VideoCapabilityDevice } from './video-player-system';

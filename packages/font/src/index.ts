// @forgeax/engine-font - MSDF font atlas baking and runtime font asset plumbing.
//
// The bake pipeline (cli-font.ts) reads a TTF and produces an MSDF atlas PNG +
// glyph-metrics sidecar via @zappar/msdf-generator. The pure helpers
// (bakeFont / encodePng / atlasToSidecar) are exported so consumers + tests
// can drive the bake with an injected generator (real: @zappar; mock: tests).
export const FONT_PACKAGE_VERSION = '0.0.0';

export {
  atlasToSidecar,
  type BakeAtlas,
  type BakeGlyph,
  type BakeResult,
  type BakeSidecar,
  bakeFont,
  encodePng,
  type MsdfGenerator,
  runCliFont,
} from './cli-font.js';

// Optional authoring features intentionally live outside the base render vocabulary.
export * from './components/glyph-text';
export * from './components/sprite-animation';
export * from './components/sprite-instances';
export * from './components/sprite-playback-mode';
export * from './components/sprite-region-override';
export * from './components/tile-layer';
export * from './components/tilemap';
export { glyphTextLayoutSystem, resetGlyphBakeCache } from './glyph-text-layout-system';
export {
  Materials,
  SPRITE_PREMULTIPLIED_ALPHA_BLEND,
} from './materials';
export {
  getTransparentSortConfig,
  setTransparentSortConfig,
  TRANSPARENT_SORT_MODE_DISTANCE,
  TRANSPARENT_SORT_MODE_LAYER_Y,
  TRANSPARENT_SORT_MODE_LAYER_YZ,
  TRANSPARENT_SORT_MODE_LAYER_Z,
  type TransparentSortConfig,
} from './systems/transparent-sort-config';
export { tilemapChunkExtractSystem } from './tilemap-chunk-extract-system';

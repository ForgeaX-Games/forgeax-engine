// @forgeax/engine-project — progressive disclosure exports (D-8, charter P1)
//
// Export order: most-used first → schema/types middle → constants/resolve last.
//   Top:    loadGameProject (primary entry point for every consumer)
//   Middle: GameProjectSchema (self-introspection, charter P2) + GameProject type
//   Bottom: FORGE_JSON constant + resolveDefaultScene + GameProjectError types

export type {
  ForgeGuidMalformedDetail,
  ForgeMissingDetail,
  ForgeParseFailedDetail,
  ForgeSceneUnresolvedDetail,
  ForgeSchemaInvalidDetail,
  ForgeUnknownFieldDetail,
  GameProjectErrorCode,
  GameProjectErrorDetail,
} from './errors.js';
export { GameProjectError } from './errors.js';
export type { ResolvedScene } from './loader.js';
// ── Top tier: primary entry points ──────────────────────────────────────────
export {
  loadGameProject,
  loadGameProjectSync,
  resolveDefaultScene,
  validateGameProject,
} from './loader.js';
// ── Bottom tier: constants + error types ────────────────────────────────────
export { FORGE_JSON } from './paths.js';
export type { GameProject } from './schema.js';
// ── Middle tier: schema self-introspection + types ──────────────────────────
export { GameProjectSchema } from './schema.js';

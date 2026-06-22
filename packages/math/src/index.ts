// @forgeax/engine-math — single-entry public API surface (D-P9 / AC-09)
//
// Shape: types SSOT top-level re-export + namespace `* as <ns>` wrappers.
//
// M1 placeholder state:
//   - types.ts seven-piece brand established (T-002);
//   - vec3 / mat4 / quat legacy implementations kept as baseline before M2 replacement;
//   - vec2 / vec4 / mat3 / quat (new) / color / euler arrive incrementally in M2~M5.
//
// Design locks (research §F-3 V8 elements-kinds + plan-strategy §K-3 SoA alignment):
//   - all numeric storage is Float32Array (types.ts brand)
//   - sideEffects: false (package.json) lets bundlers tree-shake at namespace granularity
//   - zero runtime dependencies (AC-16 + T-037 jq guard)
//
// Related: requirements §AC-09 single entry + top-level re-export;
//          plan-strategy D-P9 no sub-path + §1.1 file layering.

// === type SSOT top-level re-export ===
export type {
  Color,
  ColorLike,
  Euler,
  EulerOrder,
  Mat3,
  Mat3Like,
  Mat4,
  Mat4Like,
  Quat,
  QuatLike,
  Vec2,
  Vec2Like,
  Vec3,
  Vec3Like,
  Vec4,
  Vec4Like,
} from './types';

// === namespace re-export ===
//
// All 8 namespaces (cumulative across M1~M5):
//   - vector family vec2 / vec3 / vec4 (M2 / T-013~T-015)
//   - matrix family mat3 / mat4 (M3 / T-020~T-021)
//   - rotation quat / euler (M4 / T-027~T-028)
//   - color (M5 / T-032, 6 functions sRGB↔linear + hex parse/format)

export * as box3 from './box3';
export * as color from './color';
export * as euler from './euler';
export * as halfFloat from './f32-to-f16-bytes';
export * as frustum from './frustum';
export * as mat3 from './mat3';
export * as mat4 from './mat4';
export * as quat from './quat';
export * as ray from './ray';
export * as sphere from './sphere';
export * as vec2 from './vec2';
export * as vec3 from './vec3';
export * as vec4 from './vec4';

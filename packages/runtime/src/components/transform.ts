// @forgeax/engine-runtime - Transform (local TRS + world mat4).
//
// Schema: three local array<f32, N> columns -- pos (3-vec position), quat
// (4-quat rotation, component order [x, y, z, w]), scale (3-vec scale) --
// plus one `world: array<f32, 16>` field carrying the resolved world-space
// mat4 (column-major 16 floats, written by the propagate kernel each frame).
// Inline stride-N array columns (feat-20260602) store each row's N floats
// contiguously, so per-row xyz locality is native to the column layout; the
// former per-axis scalar decomposition (10 f32 columns) predates
// inline array columns and was retired in feat-20260709 M2.
//
// The world column is the SSOT for the resolved world transform: a root's
// world equals its local mat4; a child's world equals parent.world x local.
// AI users author the local TRS arrays and read the derived world mat4 via
// the ECS column-level array view (`world.get(e, Transform).world` -> live
// Float32Array of 16 column-major floats). They MUST NOT hand-write the
// world column -- it is overwritten by propagate.
//
// charter mapping: P1 (progressive disclosure via defaults map -- AI users
// spawn with data: {} and get identity local TRS + identity world mat4),
// F1 (context-limited: single-import barrel; 3 array keys replace 10 scalar
// keys at every spawn call-site), P4 (consistent abstraction: pos / quat /
// scale array columns follow the same access pattern as `world` -- learn
// the flat column form once, apply it to every array<f32, N> field),
// P3 (machine-readable schema > prose).

import { defineComponent } from '@forgeax/engine-ecs';

// Column-major identity mat4 (16 floats) used as the world-column default so
// `spawn({ component: Transform, data: {} })` lands an identity world view
// before the first propagate pass writes the resolved transform.
const IDENTITY_MAT4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Transform: local position `pos` (xyz), rotation `quat` (quaternion,
 * component order [x, y, z, w]), scale `scale` (xyz), plus the resolved
 * `world` mat4 (column-major 16 floats).
 *
 * Local TRS is stored as three inline stride-N array<f32, N> columns. The
 * propagate kernel composes each entity's local TRS into a mat4 and writes it
 * into the `world` column (root: world = local; child: world = parent.world x
 * local) using `@forgeax/engine-math` mat4 / vec3 / quat APIs (charter P4: do
 * not reinvent math). MVP recomposes every frame; dirty-flag optimization is
 * owned by feat-future-render-world.
 *
 * The `world` column is a fixed-capacity `array<f32, 16>` (feat-20260602):
 * the 16 contiguous floats live inline in a stride-16 column -- no BufferPool
 * slot. Read it via `world.get(e, Transform).world` which returns a live
 * `Float32Array` aliasing the column buffer. The view is transient: it aliases
 * the archetype column buffer and is valid only until the next structural
 * change (spawn / despawn / addComponent / removeComponent). Re-fetch the view
 * on every access; holding a view across a structural change is undefined
 * behaviour (the backing `ArrayBuffer` is detached on column growth, and
 * swap-remove at the same row index points to the wrong entity). All existing
 * hot paths (propagate / render-extract / pick) already comply -- see
 * `packages/ecs/README.md` Transient view contract section.
 *
 * All three local columns carry explicit layer-2 defaults (identity
 * transform): `pos: [0, 0, 0]`, `quat: [0, 0, 0, 1]` (identity quaternion,
 * [x, y, z, w]), `scale: [1, 1, 1]`. quat and scale MUST stay explicit: the
 * layer-3 fallback for array<f32, N> is all-zero, which would land an invalid
 * zero quaternion / zero scale. The `world` field defaults to the identity
 * mat4. AI users spawn with `data: {}` or with only the fields they need to
 * override.
 *
 * @example Minimal spawn (local defaulted to identity, world = identity mat4):
 *   world.spawn({ component: Transform, data: {} });
 *
 * @example Override only the position, leaving rotation/scale at identity:
 *   world.spawn({ component: Transform, data: { pos: [0, 6, 0] } });
 *
 * @example Full explicit local form (defaults are opt-in):
 *   world.spawn({ component: Transform, data: {
 *     pos: [1, 2, 3],
 *     quat: [0, 0, 0, 1], // [x, y, z, w]
 *     scale: [1, 1, 1],
 *   } });
 */
export const Transform = defineComponent('Transform', {
  pos: { type: 'array<f32, 3>', default: new Float32Array([0, 0, 0]) },
  // Component order [x, y, z, w] end to end (glTF-aligned; E6).
  quat: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 1]) },
  scale: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  // `world` is field-level transient (D-5): scene collect skips it. The resolved
  // world mat4 is derived by the propagate kernel from the persisted local TRS
  // each frame, so serializing it would store reconstructable data (SSOT: local
  // TRS). Round-trip re-derives an equivalent world on the first propagate pass.
  world: { type: 'array<f32, 16>', default: IDENTITY_MAT4, transient: true },
});

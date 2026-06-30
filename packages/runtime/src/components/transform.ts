// @forgeax/engine-runtime - Transform (local TRS + world mat4).
//
// Schema: 10 local f32 scalar columns (SoA) decomposed from the conceptual
// 3-vec position / 4-quat rotation / 3-vec scale into per-axis scalars so
// forgeax ECS column storage stays Float32-uniform (column.ts SoA invariant),
// plus one `world: array<f32, 16>` field carrying the resolved world-space
// mat4 (column-major 16 floats, written by the propagate kernel each frame).
//
// The world column is the SSOT for the resolved world transform: a root's
// world equals its local mat4; a child's world equals parent.world x local.
// AI users author the local TRS scalars and read the derived world mat4 via
// the ECS column-level array view (`world.get(e, Transform).world` -> live
// Float32Array of 16 column-major floats). They MUST NOT hand-write the
// world column -- it is overwritten by propagate.
//
// charter mapping: P1 (progressive disclosure via defaults map -- AI users
// spawn with data: {} and get identity local TRS + identity world mat4),
// F1 (context-limited: single-import barrel), P4 (consistent abstraction:
// 3-vec / 4-quat / 3-vec local + mat4 world are the AI-user-facing concepts;
// SoA column decomposition is engine internal detail surfaced via LSP hover),
// P3 (machine-readable schema > prose).

import { defineComponent } from '@forgeax/engine-ecs';

// Column-major identity mat4 (16 floats) used as the world-column default so
// `spawn({ component: Transform, data: {} })` lands an identity world view
// before the first propagate pass writes the resolved transform.
const IDENTITY_MAT4 = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * Transform: local position (xyz), rotation (xyzw quaternion), scale (xyz),
 * plus the resolved `world` mat4 (column-major 16 floats).
 *
 * Local TRS is stored as 10 f32 columns (SoA-friendly). The propagate kernel
 * composes each entity's local TRS into a mat4 and writes it into the `world`
 * column (root: world = local; child: world = parent.world x local) using
 * `@forgeax/engine-math` mat4 / vec3 / quat APIs (charter P4: do not reinvent
 * math). MVP recomposes every frame; dirty-flag optimization is owned by
 * feat-future-render-world.
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
 * All 10 local fields carry layer-2 defaults (identity transform): position
 * at origin, rotation as identity quaternion (xyzw), scale at unit. The
 * `world` field defaults to the identity mat4. AI users spawn with
 * `data: {}` or with only the fields they need to override.
 *
 * @example Minimal spawn (local defaulted to identity, world = identity mat4):
 *   world.spawn({ component: Transform, data: {} });
 *
 * @example Override only posZ, leaving all others at identity defaults:
 *   world.spawn({ component: Transform, data: { posZ: 2 } });
 *
 * @example Full 10-field explicit local form (still valid; defaults are opt-in):
 *   world.spawn({ component: Transform, data: {
 *     posX: 1, posY: 2, posZ: 3,
 *     quatX: 0, quatY: 0, quatZ: 0, quatW: 1,
 *     scaleX: 1, scaleY: 1, scaleZ: 1,
 *   } });
 */
export const Transform = defineComponent('Transform', {
  posX: { type: 'f32', default: 0 },
  posY: { type: 'f32', default: 0 },
  posZ: { type: 'f32', default: 0 },
  quatX: { type: 'f32', default: 0 },
  quatY: { type: 'f32', default: 0 },
  quatZ: { type: 'f32', default: 0 },
  quatW: { type: 'f32', default: 1 },
  scaleX: { type: 'f32', default: 1 },
  scaleY: { type: 'f32', default: 1 },
  scaleZ: { type: 'f32', default: 1 },
  world: { type: 'array<f32, 16>', default: IDENTITY_MAT4 },
});

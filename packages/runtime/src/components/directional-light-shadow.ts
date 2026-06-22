// @forgeax/engine-runtime — DirectionalLightShadow (directional light shadow
// with cascaded shadow maps).
//
// Schema: 9 f32 columns — cascadeCount (u32, stored as f32), splitLambda,
// cascadeBlend, mapSize (u32, stored as f32), depthBias, normalBias,
// nearPlane, farPlane, pcfKernelSize (u32, stored as f32).
//
// Cascade fields (feat-20260613-csm):
//   cascadeCount ∈ {1,2,3,4}  — number of cascades (default 4)
//   splitLambda   ∈ [0,1]     — PSSM split weight (default 0.75)
//   cascadeBlend  ∈ [0,0.5]   — blend width between cascades (default 0.2)
//
// mapSize default changed from 1024 to 2048 (plan-strategy D-2).
// The old fixed-extent half-extent field is gone — per-cascade AABB fitting
// replaces it (D-1).
//
// Cardinality = 1: only one shadow caster per scene (plan-strategy D-3).
// Co-located with DirectionalLight in components/ (plan-strategy D-7).
//
// Naming convention: bare entity name (AGENTS.md §Component naming), no
// Component suffix.

import { defineComponent } from '@forgeax/engine-ecs';
import { ShadowInvalidConfigError } from '../errors';

/**
 * Directional light shadow mapping parameters with cascaded shadow maps.
 *
 * Cardinality = 1: ECS enforces at most one entity carries this component
 * per World (plan-strategy D-3). Spawning or adding a second instance
 * returns {@link CardinalityExceededError} with `.code = 'cardinality-exceeded'`.
 *
 * Field validation failures emit {@link ShadowInvalidConfigError} with
 * `.code = 'shadow-invalid-config'` and `.detail.{field,value,min,max?}` for
 * property-access narrowing (no string parsing). `.hint` is imperative
 * ("set X to ...") so AI users can paste it into the next spawn call.
 *
 * @example Default 4-cascade spawn (recommended baseline):
 *   world.spawn(
 *     { component: DirectionalLight,
 *       data: { directionX: 0.2, directionY: -0.98, directionZ: 0,
 *               colorR: 1, colorG: 1, colorB: 1, intensity: 1 } },
 *     { component: DirectionalLightShadow,
 *       data: { cascadeCount: 4, splitLambda: 0.75, cascadeBlend: 0.2,
 *               mapSize: 2048, nearPlane: 0.1, farPlane: 50 } },
 *   ).unwrap();
 *
 * @example cascadeCount=1 degenerate (compact scenes / low-budget devices):
 *   // Same WGSL kernel as 4-cascade -- no separate fallback shader variant.
 *   world.spawn(
 *     { component: DirectionalLight, data: { directionX: 0, directionY: -1, directionZ: 0 } },
 *     { component: DirectionalLightShadow, data: { cascadeCount: 1, mapSize: 1024 } },
 *   ).unwrap();
 */
export const DirectionalLightShadow = defineComponent(
  'DirectionalLightShadow',
  {
    cascadeCount: { type: 'f32', default: 4 },
    splitLambda: { type: 'f32', default: 0.75 },
    cascadeBlend: { type: 'f32', default: 0.2 },
    mapSize: { type: 'f32', default: 2048 },
    depthBias: { type: 'f32', default: 0.005 },
    normalBias: { type: 'f32', default: 0.05 },
    nearPlane: { type: 'f32', default: 0.1 },
    farPlane: { type: 'f32', default: 50 },
    pcfKernelSize: { type: 'f32', default: 3 },
  },
  {
    cardinality: 1,
    validate(data) {
      const ms = data.mapSize as number | undefined;
      if (ms !== undefined && ms < 1) {
        return new ShadowInvalidConfigError('mapSize', ms, 1);
      }
      const cc = data.cascadeCount as number | undefined;
      if (cc !== undefined && (cc < 1 || cc > 4 || !Number.isInteger(cc))) {
        return new ShadowInvalidConfigError('cascadeCount', cc, 1, 4);
      }
      const sl = data.splitLambda as number | undefined;
      if (sl !== undefined && (sl < 0 || sl > 1)) {
        return new ShadowInvalidConfigError('splitLambda', sl, 0, 1);
      }
      const cb = data.cascadeBlend as number | undefined;
      if (cb !== undefined && (cb < 0 || cb > 0.5)) {
        return new ShadowInvalidConfigError('cascadeBlend', cb, 0, 0.5);
      }
      return null;
    },
  },
);

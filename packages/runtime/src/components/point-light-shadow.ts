// @forgeax/engine-runtime — PointLightShadow (omnidirectional point-light
// shadow mapping parameters; cube-array atlas variant).
//
// Schema: 6 f32 columns — mapSize (u32, stored as f32), depthBias, normalBias,
// nearPlane, farPlane, pcfKernelSize (u32, stored as f32). No fixed-extent
// field — cube map uses fov=90 perspective, not ortho.
//
// Cardinality = 4: at most 4 shadow-casting point lights per scene
// (feat-20260612 plan-strategy §D-1 cube_array atlas layers=4 cap).
// Co-located with DirectionalLight in components/ (research L1.2).
//
// Naming convention: bare entity name (AGENTS.md §Component naming), no
// Component suffix. Same defineComponent pattern and ShadowInvalidConfigError
// surface as the shadow fields merged into DirectionalLight (feat-20260621 M1).

import { defineComponent } from '@forgeax/engine-ecs';
import { ShadowInvalidConfigError } from '../errors';

/**
 * Omnidirectional point-light shadow mapping parameters.
 *
 * Cardinality = 4: ECS enforces at most four entities carry this component
 * per World (plan-strategy §D-1, atlas cube_array.layers = 4). Spawning a
 * fifth instance returns `CardinalityExceededError` with
 * `.code = 'cardinality-exceeded'` (AC-06).
 *
 * @example Spawn a point light with default shadow config:
 *   world.spawn(
 *     { component: Transform, data: { posX: 0, posY: 4, posZ: 0 } },
 *     { component: PointLight, data: { range: 25 } },
 *     { component: PointLightShadow, data: {} }, // 6 fields filled from defaults
 *   );
 *
 * @example Spawn with explicit map size and bias:
 *   world.spawn(
 *     { component: PointLightShadow, data: { mapSize: 1024, depthBias: 0.01 } },
 *   );
 */
export const PointLightShadow = defineComponent(
  'PointLightShadow',
  {
    mapSize: { type: 'f32', default: 512 },
    depthBias: { type: 'f32', default: 0.005 },
    normalBias: { type: 'f32', default: 0.05 },
    nearPlane: { type: 'f32', default: 0.1 },
    farPlane: { type: 'f32', default: 25 },
    pcfKernelSize: { type: 'f32', default: 3 },
  },
  {
    cardinality: 4,
    validate(data) {
      const ms = data.mapSize as number | undefined;
      if (ms !== undefined && ms < 1) {
        return new ShadowInvalidConfigError('mapSize', ms, 1);
      }
      // farPlane must be strictly greater than nearPlane (perspectiveZO
      // degrades to NaN at far=near). Surface error with comparator='>' so the
      // hint string matches the actual check; AI users setting farPlane=nearPlane
      // get a clear "must be > nearPlane" rather than a "must be >= nearPlane"
      // that re-fails the loop (Pure simulator finding D-pure-1).
      const near = data.nearPlane as number | undefined;
      const far = data.farPlane as number | undefined;
      if (near !== undefined && far !== undefined && far <= near) {
        return new ShadowInvalidConfigError('farPlane', far, near, '>');
      }
      // pcfKernelSize must be odd and >= 1 (README §AC-11). Even values produce
      // an asymmetric kernel; values < 1 disable PCF entirely (caller should
      // remove the component instead).
      const pcf = data.pcfKernelSize as number | undefined;
      if (pcf !== undefined && (pcf < 1 || pcf % 2 === 0)) {
        return new ShadowInvalidConfigError('pcfKernelSize', pcf, 1);
      }
      return null;
    },
  },
);

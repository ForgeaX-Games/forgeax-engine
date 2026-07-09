// @forgeax/engine-runtime - PointLight (omnidirectional point-light parameters).
//
// Schema: 5 f32 columns - color (rgb, linear space) + intensity + range.
// `position` comes from the Transform component; PointLight requires a
// companion Transform on the same entity (ECS query: `[Transform, PointLight]`).
// `range` units are meters; defaults to `10.0` (KHR_lights_punctual quartic
// falloff with `1 / (range^2)` clamped at the host-side helper — see
// `light-helpers.ts` `computeInvRangeSquared`).
//
// 0 light + standard material -> physically correct black render
// (feat-20260518-pbr-direct-lighting-mvp). The runtime once-warn channel
// (M5 / w25) collapses to "directionalCount + pointCount + spotCount === 0";
// see packages/runtime/README.md section Common pitfalls for the AI-user
// guidance after the M5 docs land.
//
// Naming convention: bare entity name aligned with Bevy ECS conventions
// (feat-20260513-component-naming-bevy-align). DirectionalLight / SpotLight
// follow the same single-semantic-entity rule (charter proposition 5).
//
// charter mapping: proposition 1 (single import + IDE autocomplete on
// payload.range) + proposition 3 (silent failure -> explicit failure;
// spawn-time fail-fast on range<0 / NaN with structured EcsError) +
// proposition 5 (consistent abstraction: shared payload shape with
// SpotLight; `range` semantics aligned with KHR_lights_punctual).

import { defineComponent, SpawnLightInvalidBoundsError } from '@forgeax/engine-ecs';

/**
 * Omnidirectional point light (KHR_lights_punctual `point` type).
 *
 * `position` source: the companion `Transform` component on the same entity.
 * Spawn via `world.spawn({ component: Transform, data: ... }, { component: PointLight, data: ... })`
 * so the render system extract path can join the two via the
 * `[Transform, PointLight]` ECS query.
 *
 * `color` is linear-space rgb in `[0, 1]` per channel; `intensity` is a
 * scalar multiplier; `range` is in meters and defaults to `10.0`
 * (KHR convention; `+Infinity` is the KHR no-truncation value, retained
 * for KHR_lights_punctual `range: 0` bridging via `light-helpers.ts`).
 * Falloff follows `max(min(1 - (d^2 / range^2)^2, 1), 0) / max(d^2, 1e-4)`
 * (KHR quartic + shader-side `1/d^2` math safety net per plan-strategy D-S5).
 *
 * @example Spawn a single point light at (5, 3, 5):
 *   world.spawn(
 *     { component: Transform, data: { pos: [5, 3, 5] } },
 *     { component: PointLight, data: { intensity: 8, range: 25 } },
 *   );
 *
 * @example Minimal spawn -- defaults give neutral white at full strength, range 10m:
 *   world.spawn(
 *     { component: Transform, data: { pos: [0, 1, 0] } },
 *     { component: PointLight, data: {} },
 *   );
 *   // resolves to colorR=colorG=colorB=1, intensity=1, range=10.0.
 */
export const PointLight = defineComponent(
  'PointLight',
  {
    colorR: { type: 'f32', default: 1 },
    colorG: { type: 'f32', default: 1 },
    colorB: { type: 'f32', default: 1 },
    intensity: { type: 'f32', default: 1 },
    range: { type: 'f32', default: 10.0 },
  },
  {
    validate: (data) => {
      const range = data.range as number;
      if (typeof range !== 'number' || Number.isNaN(range) || range < 0) {
        return new SpawnLightInvalidBoundsError('PointLight', 'range', range);
      }
      return null;
    },
  },
);

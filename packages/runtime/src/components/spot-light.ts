// @forgeax/engine-runtime - SpotLight (cone-restricted spot-light parameters).
//
// Schema: 9 f32 columns - direction (xyz) + color (rgb, linear space) +
// intensity + range + innerConeDeg + outerConeDeg. `position` comes from the
// Transform component; SpotLight requires a companion Transform on the same
// entity (ECS query: `[Transform, SpotLight]`). Cone units are degrees on
// the Component API surface (charter F1 prior-knowledge alignment with
// Three.js); the host-side extract step pre-converts to `cosInner` /
// `cosOuter` before GPU upload (plan-strategy section 8.2 naming convention
// + D-3 host-side cone conversion).
//
// `range` units are meters; defaults to `10.0` (KHR_lights_punctual convention).
// Falloff follows the same KHR quartic formula as PointLight; the cone falloff
// is layered on top with `smoothstep(cosOuter, cosInner, dot(L, -direction))`
// (plan-strategy D-S4).
//
// 0 light + standard material -> physically correct black render. The
// once-warn channel collapses to "directionalCount + pointCount +
// spotCount === 0" (M5 / w25).
//
// feat-20260625-spot-light-shadow-mapping M1 w4: embedded castShadow (default true)
// + 6 shadow fields (mapSize / depthBias / normalBias / nearPlane / farPlane /
// pcfKernelSize) aligned with DirectionalLight vocabulary (plan-strategy D-6;
// charter P4 consistent abstraction). Zero-config spawns cast spot shadows;
// set castShadow:false to opt out (validate short-circuits on false, AC-03).
// Shadow atlas cap of 4 is enforced at extract stage, not component layer (OOS-5).
//
// charter mapping: proposition 1 (single import + IDE autocomplete on
// payload.outerConeDeg with no `as` cast) + proposition 3 (silent failure
// -> explicit failure; spawn-time fail-fast on three bound violations) +
// proposition 5 (consistent abstraction: outgoing direction semantics
// shared with DirectionalLight; cone deg API + cos shader uniform
// pre-conversion mirrors directional path's host-side `lightDir x intensity`
// pre-multiplication).

import { defineComponent, SpawnLightInvalidBoundsError } from '@forgeax/engine-ecs';
import { ShadowInvalidConfigError } from '../errors';

/**
 * Cone-restricted spot light (KHR_lights_punctual `spot` type).  Casts shadows
 * by default (castShadow defaults to true) — zero-config spawns project hard
 * PCF shadows through an independent spot depth atlas.
 *
 * `direction` @semantics outgoing -- points FROM light source TO the
 * scene (consistent with `DirectionalLight`; the shader internally negates
 * this vector to obtain the L vector for BRDF evaluation:
 * `let l = normalize(-light.direction)`). `normalize` yourself if needed --
 * the shader does not re-normalize. `position` source: the companion
 * `Transform` component on the same entity.
 *
 * `innerConeDeg` is the half-angle of the saturated bright region (cone
 * fully bright at the axis); `outerConeDeg` is the half-angle of the
 * falloff edge (cone fully dark beyond). Unit is **degrees**;
 * `outerConeDeg in (innerConeDeg, 90]` (KHR upper bound; spawn-time
 * validation rejects `outer > 90` and `outer <= inner`). The host-side
 * extract step converts both to `cos*` before GPU upload so the shader
 * only sees pre-computed cosines (plan-strategy D-S2 byte freeze; charter
 * P4 host pre-multiplication parity).
 *
 * `color` is linear-space rgb in `[0, 1]` per channel; `intensity` is a
 * scalar multiplier; `range` is in meters and defaults to `10.0`.
 *
 * Shadow fields (embedded, aligned with DirectionalLight):
 *   castShadow    ∈ {true, false}    — shadow opt-out gate (default true)
 *   mapSize       >= 1               — shadow map resolution per tile (default 2048)
 *   depthBias                        — shadow acne bias (default 0.005)
 *   normalBias                       — shadow acne normal offset (default 0.05)
 *   nearPlane                        — shadow-camera near (default 0.1)
 *   farPlane                         — shadow-camera far (default 50)
 *   pcfKernelSize odd >= 1           — PCF kernel width (default 3)
 *
 * Atlas capacity is capped at 4 castShadow spot lights by the extract stage;
 * the 5th light onward keeps direct illumination but shadowAtlasTile = -1
 * (AC-05: clip is programmatically detectable, light stays visible).
 *
 * @example Spawn a single spot light casting shadows (zero-config):
 *   world.spawn(
 *     { component: Transform, data: { posX: 0, posY: 5, posZ: 0 } },
 *     { component: SpotLight, data: { directionX: 0, directionY: -1, directionZ: 0 } },
 *   );
 *
 * @example Opt out of shadows:
 *   world.spawn(
 *     { component: Transform, data: { posX: 0, posY: 5, posZ: 0 } },
 *     { component: SpotLight, data: { directionX: 0, directionY: -1, directionZ: 0, castShadow: false } },
 *   );
 *
 * @example Explicit shadow config:
 *   world.spawn(
 *     { component: Transform, data: { posX: 0, posY: 5, posZ: 0 } },
 *     { component: SpotLight, data: { directionX: 0, directionY: -1, directionZ: 0, depthBias: 0.01, normalBias: 0.08, mapSize: 1024 } },
 *   );
 *
 * @example Minimal spawn -- defaults give neutral white at full strength, range 10m, KHR pi/4 cone:
 *   world.spawn(
 *     { component: Transform, data: { posX: 0, posY: 5, posZ: 0 } },
 *     { component: SpotLight, data: { directionX: 0, directionY: -1, directionZ: 0 } },
 *   );
 *   // resolves to color=[1,1,1], intensity=1, range=10.0,
 *   // innerConeDeg=0, outerConeDeg=45 (KHR pi/4 equivalent).
 */
export const SpotLight = defineComponent(
  'SpotLight',
  {
    directionX: { type: 'f32' },
    directionY: { type: 'f32' },
    directionZ: { type: 'f32' },
    colorR: { type: 'f32', default: 1 },
    colorG: { type: 'f32', default: 1 },
    colorB: { type: 'f32', default: 1 },
    intensity: { type: 'f32', default: 1 },
    range: { type: 'f32', default: 10.0 },
    innerConeDeg: { type: 'f32', default: 0 },
    outerConeDeg: { type: 'f32', default: 45 },
    // Shadow opt-out gate: defaults to true so zero-config spawns cast shadows.
    castShadow: { type: 'bool', default: true },
    // 6 shadow fields aligned with DirectionalLight (plan-strategy D-6).
    mapSize: { type: 'f32', default: 2048 },
    depthBias: { type: 'f32', default: 0.005 },
    normalBias: { type: 'f32', default: 0.05 },
    nearPlane: { type: 'f32', default: 0.1 },
    farPlane: { type: 'f32', default: 50 },
    pcfKernelSize: { type: 'f32', default: 3 },
  },
  {
    validate: (data) => {
      const cs = data.castShadow;
      if (cs === false) {
        return null;
      }
      const range = data.range as number;
      if (typeof range !== 'number' || Number.isNaN(range) || range < 0) {
        return new SpawnLightInvalidBoundsError('SpotLight', 'range', range);
      }
      const inner = data.innerConeDeg as number;
      const outer = data.outerConeDeg as number;
      if (outer > 90) {
        return new SpawnLightInvalidBoundsError('SpotLight', 'outerNinety', outer);
      }
      if (outer <= inner) {
        return new SpawnLightInvalidBoundsError('SpotLight', 'innerOuter', outer);
      }
      const ms = data.mapSize as number | undefined;
      if (ms !== undefined && ms < 1) {
        return new ShadowInvalidConfigError('mapSize', ms, 1);
      }
      const near = data.nearPlane as number | undefined;
      const far = data.farPlane as number | undefined;
      if (near !== undefined && far !== undefined && far <= near) {
        return new ShadowInvalidConfigError('farPlane', far, near);
      }
      const pcf = data.pcfKernelSize as number | undefined;
      if (pcf !== undefined && (pcf < 1 || pcf % 2 === 0)) {
        return new ShadowInvalidConfigError('pcfKernelSize', pcf, 1);
      }
      return null;
    },
  },
);

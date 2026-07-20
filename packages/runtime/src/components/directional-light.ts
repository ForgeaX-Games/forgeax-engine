// @forgeax/engine-runtime - DirectionalLight (directional light parameters
// with merged shadow config).
//
// Schema: direction array<f32,3> + color array<f32,3> + intensity f32 + 1 bool
// castShadow + 8 f32 shadow columns (feat-20260709 M2: direction/color collapsed
// from 6 per-axis scalar columns to two inline array<f32,3> columns).
//
// Direction (xyz, normalized) + color (rgb, linear space) + intensity.
// No Transform dependency (directional lights have no position).
//
// 0 DirectionalLight + standard material -> physically correct black render
// (charter v2 P3/P4); details: AGENTS.md section Breaking changes 2026-05-18.
//
// Naming convention: bare entity name aligned with Bevy ECS conventions
// (feat-20260513-component-naming-bevy-align). Camera / Transform / etc.
// follow the same single-semantic-entity rule (charter proposition 5).
//
// charter mapping: proposition 1 (single import) + proposition 3 (silent
// failure -> explicit warning; first-frame warn) + proposition 5 (consistent
// abstraction: lighting parameters mirror GPU-side pbr.wgsl @group(0) view
// BG light fields).
//
// feat-20260621-merge-directionallightshadow-into-directionallight M1:
// DirectionalLightShadow's 9 shadow fields are merged into DirectionalLight
// to collapse the dual-component spawn into a single component (D-6 primary
// decision). castShadow defaults to true so zero-config spawns get shadows
// by default; set castShadow=false to opt out. D-6 directional stays
// first-hit-wins -- no cardinality cap. The separate DirectionalLightShadow
// component and its cardinality bound are deleted in m1-t6.

import { defineComponent } from '@forgeax/engine-ecs';
import { ShadowInvalidConfigError } from '../errors/render';
import { validateDirection } from '../light-helpers';

/**
 * Directional light (sun-like infinite light source) with merged shadow
 * parameters.
 *
 * `direction` @semantics outgoing — points FROM light source TO surface
 * (opposite of Three.js convention; the shader internally negates this
 * vector to obtain the L vector for BRDF evaluation). `normalize` yourself
 * if needed - the shader does not re-normalize. `color` is linear-space rgb
 * in [0, 1] per channel.
 *
 * castShadow defaults to true — zero-config spawns cast cascaded shadow maps.
 * Set castShadow: false to opt out (shadow fields are still stored but their
 * validation is skipped).
 *
 * Shadow fields (migrated from DirectionalLightShadow, feat-20260621 M1):
 *   cascadeCount   ∈ {1,2,3,4}  — number of cascades (default 4)
 *   splitLambda    ∈ [0,1]      — PSSM split weight (default 0.75)
 *   cascadeBlend   ∈ [0,0.5]    — blend width between cascades (default 0.2)
 *   mapSize        >= 1         — shadow map resolution (default 2048)
 *   depthBias                    — shadow acne bias (default 0.005)
 *   normalBias                   — shadow acne normal offset (default 0.05)
 *   shadowDistance > 0           — how far shadows reach in front of the camera,
 *                                  in world units (default 200). This is the sole
 *                                  coverage knob: the CSM cascades are PSSM-split
 *                                  across [camera near, shadowDistance] and each
 *                                  cascade's orthographic bounds are fit to the
 *                                  camera frustum slice automatically. The near
 *                                  end is derived from the active camera's near
 *                                  plane (no separate near knob — any value other
 *                                  than the camera near either drops near shadows
 *                                  or wastes cascade-0 resolution).
 *   pcfKernelSize  odd >= 1     — PCF kernel width (default 3)
 *
 * @example Spawn a single directional light with default shadows:
 *   world.spawn({ component: DirectionalLight, data: {
 *     direction: [-0.5, -1, -0.3], // [x, y, z]
 *     color: [1, 1, 1], // [r, g, b]
 *     intensity: 1,
 *   } });
 *
 * @example Opt out of shadows:
 *   world.spawn({ component: DirectionalLight, data: {
 *     direction: [0, -1, 0], // [x, y, z]
 *     castShadow: false,
 *   } });
 *
 * @example Explicit shadow config (single-component spawn):
 *   world.spawn({ component: DirectionalLight, data: {
 *     direction: [0.2, -0.98, 0], // [x, y, z]
 *     color: [1, 1, 1], intensity: 1, // color is [r, g, b]
 *     cascadeCount: 4, splitLambda: 0.75, cascadeBlend: 0.2,
 *     mapSize: 2048, shadowDistance: 200,
 *   } });
 *
 * @example 0-light scene must use an unlit shader (standard 0 light = physically correct black):
 *   const world = new World();
 *   // ... spawn cube + camera, no light ...
 *   await renderer.ready;
 *   renderer.draw(world); // standard material renders black; switch to an unlit shader (Materials.unlit(...)) for an unlit display
 */
export const DirectionalLight = defineComponent(
  'DirectionalLight',
  {
    // direction is the ONLY field with no default (D-5): omitting it lands the
    // array layer-3 all-zero [0,0,0], which validate() rejects -- there is no
    // universal default direction, so "default is illegal" forces an explicit
    // non-zero value. color carries an explicit layer-2 default [1,1,1] (white);
    // the array layer-3 fallback is all-zero, so the default MUST be explicit.
    direction: { type: 'array<f32, 3>' },
    color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
    intensity: { type: 'f32', default: 1 },
    // Shadow opt-out gate: defaults to true so zero-config spawns get shadows.
    castShadow: { type: 'bool', default: true },
    // 9 shadow fields migrated from DirectionalLightShadow (feat-20260621 M1).
    cascadeCount: { type: 'f32', default: 4 },
    splitLambda: { type: 'f32', default: 0.75 },
    cascadeBlend: { type: 'f32', default: 0.2 },
    mapSize: { type: 'f32', default: 2048 },
    depthBias: { type: 'f32', default: 0.005 },
    normalBias: { type: 'f32', default: 0.05 },
    // Sole shadow coverage knob (feat replaces nearPlane/farPlane). The PSSM
    // near end derives from the active camera near; shadowDistance is the far
    // reach. Default 200 world units (matches UE-style "dynamic shadow
    // distance"; the old farPlane default was 50).
    shadowDistance: { type: 'f32', default: 200 },
    pcfKernelSize: { type: 'f32', default: 3 },
  },
  {
    validate(data) {
      // D-1: reject a missing or zero-vector direction (shared SSOT helper).
      const dirErr = validateDirection(
        'DirectionalLight',
        data.direction as ArrayLike<number> | undefined,
      );
      if (dirErr !== null) return dirErr;
      // castShadow may be undefined when validation runs before defaults fill
      // (not the case in the current ECS pipeline — defaults fill first per
      // world.ts:740-743). But defend against the edge: undefined = default true.
      const cs = data.castShadow;
      if (cs === false) {
        return null;
      }
      // When castShadow is true (or undefined/default-true), enforce constraints.
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
      const pcf = data.pcfKernelSize as number | undefined;
      if (pcf !== undefined && (pcf < 1 || pcf % 2 === 0)) {
        return new ShadowInvalidConfigError('pcfKernelSize', pcf, 1);
      }
      const sd = data.shadowDistance as number | undefined;
      if (sd !== undefined && sd <= 0) {
        return new ShadowInvalidConfigError('shadowDistance', sd, 0);
      }
      return null;
    },
  },
);

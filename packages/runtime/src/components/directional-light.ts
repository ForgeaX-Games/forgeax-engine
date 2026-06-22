// @forgeax/engine-runtime - DirectionalLight (directional light parameters).
//
// Schema: 7 f32 columns - direction (xyz, normalized) + color (rgb, linear
// space) + intensity. No Transform dependency (directional lights have no
// position).
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

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Directional light (sun-like infinite light source).
 *
 * `direction` @semantics outgoing — points FROM light source TO surface
 * (opposite of Three.js convention; the shader internally negates this
 * vector to obtain the L vector for BRDF evaluation). `normalize` yourself
 * if needed - the shader does not re-normalize. `color` is linear-space rgb
 * in [0, 1] per channel.
 *
 * @example Spawn a single directional light:
 *   world.spawn({ component: DirectionalLight, data: {
 *     directionX: -0.5, directionY: -1, directionZ: -0.3,
 *     colorR: 1, colorG: 1, colorB: 1,
 *     intensity: 1,
 *   } });
 *
 * @example 0-light scene must use shadingModel:'unlit' (standard 0 light = physically correct black):
 *   const world = new World();
 *   // ... spawn cube + camera, no light ...
 *   await renderer.ready;
 *   renderer.draw(world); // standard material renders black; switch to shadingModel:'unlit' for an unlit display
 */
export const DirectionalLight = defineComponent('DirectionalLight', {
  directionX: { type: 'f32' },
  directionY: { type: 'f32' },
  directionZ: { type: 'f32' },
  colorR: { type: 'f32', default: 1 },
  colorG: { type: 'f32', default: 1 },
  colorB: { type: 'f32', default: 1 },
  intensity: { type: 'f32', default: 1 },
});

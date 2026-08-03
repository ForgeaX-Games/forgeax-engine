// Shared Bevy `text2d` scene for the browser app and the Dawn smoke.
//
// Bevy's source demonstrates Text2d as ordinary world-space text attached to
// moving spatial entities: translation, rotation, scale, and a multi-line
// label. ForgeaX's public equivalent is GlyphText + Transform. The scene keeps
// that mapping explicit so the smoke cannot silently test a different scene.

import type { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { defineComponent, type EntityHandle, type World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { Camera, DirectionalLight, orthographic } from '@forgeax/engine-render';
import { GlyphText } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { Handle } from '@forgeax/engine-types';

export const SAMPLER_GUID = '019eb276-4d96-7313-b4f0-f5d55536acd2';
export const TEXT2D_FONT_SIZE = 0.018;

export const Text2dMotion = defineComponent('BevyText2dMotion', {
  phase: { type: 'f32', default: 0 },
});

export interface Text2dScene {
  readonly translation: EntityHandle;
  readonly rotation: EntityHandle;
  readonly scale: EntityHandle;
  readonly multiline: EntityHandle;
}

export function registerSharedSampler(assets: AssetRegistry): void {
  const parsed = AssetGuid.parse(SAMPLER_GUID);
  if (!parsed.ok) throw new Error(`[bevy-text2d] SAMPLER_GUID parse failed: ${parsed.error.code}`);
  assets.catalog(parsed.value, {
    kind: 'sampler',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
    addressModeW: 'clamp-to-edge',
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'nearest',
  });
}

export function buildText2dWorld(
  world: World,
  fontHandle: Handle<'FontAsset', 'shared'>,
): Text2dScene {
  const spawn = (
    text: string,
    pos: readonly [number, number, number],
    color: readonly [number, number, number, number],
  ): EntityHandle => world.spawn(
    { component: Transform, data: { pos, quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: GlyphText, data: { fontHandle, text, fontSize: TEXT2D_FONT_SIZE, color } },
    { component: Text2dMotion, data: {} },
  ).unwrap();

  const scene = {
    translation: spawn('translation', [-4.4, 1.3, 0], [0.45, 0.9, 1, 1]),
    rotation: spawn('rotation', [-1.8, 0.15, 0], [1, 0.7, 0.3, 1]),
    scale: spawn('scale', [2.1, 1.3, 0], [0.55, 1, 0.55, 1]),
    multiline: spawn('multi\nline', [-1.0, -1.45, 0], [0.6, 0.85, 1, 1]),
  } satisfies Text2dScene;

  world.spawn(
    { component: DirectionalLight, data: { direction: [-0.3, -0.5, -1], color: [1, 1, 1], intensity: 1.2, castShadow: false } },
  ).unwrap();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -5, right: 5, bottom: -3, top: 3, near: 0.1, far: 100 }) },
  ).unwrap();
  return scene;
}

export function stepText2d(world: World, scene: Text2dScene, dt: number): void {
  const handles = [scene.translation, scene.rotation, scene.scale];
  for (const handle of handles) {
    const motion = world.get(handle, Text2dMotion);
    if (!motion.ok) continue;
    world.set(handle, Text2dMotion, { phase: motion.value.phase + dt });
  }

  const translationPhase = world.get(scene.translation, Text2dMotion);
  if (translationPhase.ok) {
    const phase = translationPhase.value.phase;
    world.set(scene.translation, Transform, {
      pos: [-4.4 + Math.sin(phase * 1.2) * 0.35, 1.3 + Math.cos(phase * 1.2) * 0.18, 0],
    });
  }

  const rotationPhase = world.get(scene.rotation, Text2dMotion);
  if (rotationPhase.ok) {
    world.set(scene.rotation, Transform, {
      quat: quat.fromAxisAngle(quat.create(), [0, 0, 1], Math.sin(rotationPhase.value.phase * 1.4) * 0.65),
    });
  }

  const scalePhase = world.get(scene.scale, Text2dMotion);
  if (scalePhase.ok) {
    const scale = 1 + Math.sin(scalePhase.value.phase * 1.6) * 0.22;
    world.set(scene.scale, Transform, { scale: [scale, scale, 1] });
  }
}

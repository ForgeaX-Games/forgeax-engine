// Shared scene for Bevy `sprite`: one image-backed Sprite.

import { HANDLE_QUAD } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { Camera, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import { Transform } from '@forgeax/engine-scene';
import type { MaterialAsset } from '@forgeax/engine-types';

export const SPRITE_SIZE = 48;

export function makeSpritePixels(): Uint8Array {
  const data = new Uint8Array(SPRITE_SIZE * SPRITE_SIZE * 4);
  for (let y = 0; y < SPRITE_SIZE; y++) {
    for (let x = 0; x < SPRITE_SIZE; x++) {
      const offset = (y * SPRITE_SIZE + x) * 4;
      const dx = x - SPRITE_SIZE / 2 + 0.5;
      const dy = y - SPRITE_SIZE / 2 + 0.5;
      const inDisc = dx * dx + dy * dy < 20 * 20;
      const inBand = Math.abs(dx) < 4 || Math.abs(dy) < 4;
      const color: readonly [number, number, number] = inBand ? [242, 198, 64] : [56, 164, 232];
      data[offset] = color[0];
      data[offset + 1] = color[1];
      data[offset + 2] = color[2];
      data[offset + 3] = inDisc ? 255 : 0;
    }
  }
  return data;
}

export function spriteMaterial(texture: number, sampler: number): MaterialAsset {
  return {
    kind: 'material',
    passes: [
      {
        name: 'Forward',
        shader: 'forgeax::sprite',
        tags: { LightMode: 'Forward' },
        queue: 3000,
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
      },
    ],
    paramValues: {
      colorTint: [1, 1, 1, 1],
      baseColorTexture: texture,
      sampler,
      pivotAndSize: [0.5, 0.5, 1, 1],
    },
  };
}

export function buildSpriteWorld(world: World, texture: number): void {
  const sampler = world.allocSharedRef('SamplerAsset', {
    kind: 'sampler',
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const material = world.allocSharedRef('MaterialAsset', spriteMaterial(texture, sampler));

  world.spawn(
    { component: Transform, data: { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [4, 4, 1] } },
    { component: MeshFilter, data: { assetHandle: HANDLE_QUAD } },
    { component: MeshRenderer, data: { materials: [material] } },
  );
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 10], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -5, right: 5, bottom: -3, top: 3, near: 0.1, far: 100 }) },
  );
}

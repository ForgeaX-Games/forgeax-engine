import type { World } from '@forgeax/engine-ecs';
import { Materials, type Renderer } from '@forgeax/engine-render';
import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-render/authoring';
import type { Handle, MaterialAsset } from '@forgeax/engine-runtime';
import hitFlashShader from './hit-flash.wgsl';

export const HIT_FLASH_SHADER_ID = 'game_default::hit_flash';
export const HIT_FLASH_SHADER_SOURCE = hitFlashShader.wgsl;
export const HIT_FLASH_ALPHA = 0.72;
export type HitFlashMaterialHandle = Handle<'MaterialAsset', 'shared'>;

/** Register the custom hit material and return its world-owned asset handle. */
export function createHitFlashMaterial(world: World, renderer?: Renderer): HitFlashMaterialHandle {
  if (renderer !== undefined) {
    const registry = renderer.shader;
    if (!registry.lookupMaterialShader(HIT_FLASH_SHADER_ID).ok) {
      registry.registerMaterialShader(HIT_FLASH_SHADER_ID, {
        source: HIT_FLASH_SHADER_SOURCE,
        paramSchema: [
          { name: 'baseColor', type: 'color' },
          { name: 'intensity', type: 'f32' },
        ],
      });
    }
    return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', {
      kind: 'material',
      passes: [{
        name: 'Forward',
        shader: HIT_FLASH_SHADER_ID,
        tags: { LightMode: 'Forward' },
        queue: 2000,
        // A hit is a transient overlay, so use the same premultiplied-alpha
        // blend contract as sprite assets instead of inventing a second mode.
        renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND, depthWriteEnabled: false },
      }],
      paramValues: { baseColor: [1, 0.82, 0.15, HIT_FLASH_ALPHA], intensity: 3 },
    });
  }

  // Standalone bootstrap has no renderer registry; retain a visible fallback
  // while the official Preview host exercises the custom shader path above.
  return world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.standard({
    baseColor: [1, 0.82, 0.15, 1],
    roughness: 0.5,
    metallic: 0,
    emissive: [1, 0.7, 0.1],
    emissiveIntensity: 5,
  }));
}

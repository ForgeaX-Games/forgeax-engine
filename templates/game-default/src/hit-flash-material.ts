import type { World } from '@forgeax/engine-ecs';
import { Materials, type Renderer } from '@forgeax/engine-render';
import type { Handle, MaterialAsset } from '@forgeax/engine-runtime';
import hitFlashShader from './hit-flash.wgsl';

export const HIT_FLASH_SHADER_ID = 'game_default::hit_flash';
export const HIT_FLASH_SHADER_SOURCE = hitFlashShader.wgsl;
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
      passes: [{ name: 'Forward', shader: HIT_FLASH_SHADER_ID, tags: { LightMode: 'Forward' }, queue: 2000 }],
      paramValues: { baseColor: [1, 0.82, 0.15, 1], intensity: 3 },
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

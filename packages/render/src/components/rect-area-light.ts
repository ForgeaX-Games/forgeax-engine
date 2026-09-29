// @forgeax/engine-render - single-sided rectangular area-light authoring facts.

import { defineComponent } from '@forgeax/engine-ecs';

/**
 * Single-sided rectangular area light. Transform supplies the center and
 * world orientation; width and height remain authored emitter dimensions.
 *
 * `sourceTexture` optionally paints the emitter with an uncompressed 2D
 * TextureAsset of any size (Unreal `SourceTexture`): RGBA8 / BGRA8 (sRGB or
 * linear), R8 grayscale, or RGBA16F / RGBA32F clipped to [0, 1]. The light's
 * local +X maps to u, local +Y to v = 0 (image top), RGB multiplies
 * `color * intensity` and alpha is ignored.
 * Diffuse reads a wide prefiltered level; specular sharpens with roughness,
 * so glossy receivers reflect the image. Requires the extended-lighting
 * topology; without it the emitter stays uniform.
 */
export const RectAreaLight = defineComponent('RectAreaLight', {
  color: { type: 'array<f32, 3>', default: new Float32Array([1, 1, 1]) },
  intensity: { type: 'f32', default: 1 },
  width: { type: 'f32', default: 1 },
  height: { type: 'f32', default: 1 },
  range: { type: 'f32', default: 10 },
  sourceTexture: { type: 'shared<TextureAsset>' },
});

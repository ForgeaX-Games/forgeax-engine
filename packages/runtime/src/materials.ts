// M3 / w15: Materials.unlit / Materials.standard factory functions
// (feat-20260526-material-asset-multipass-renderstate +
//  feat-20260612-hdrp-deferred-shading M3 / w15)
//
// Returns pass-based MaterialAsset shape per plan-strategy D-1 / D-4.
// Replaces the old UnlitMaterialAsset / SchemaDrivenMaterialAsset
// return shapes with unified pass-based MaterialAsset.
//
// Charter P1 progressive disclosure: Materials. autocomplete exposes
// unlit / standard in a single IDE completion chain.
//
// Design decisions:
//   D-1: pass-based MaterialAsset unified interface — single kind='material'.
//   D-2: RenderQueue.Geometry=2000 default queue for Forward pass.
//   D-4: 3-pass literal — deferred (fs_gbuffer) + forward (fs_main) + shadow-caster.
//     HDRP execute selects pass by passKind + alpha-blend state; AI users call
//     Materials.standard() without knowing passKind routing internals (charter P4).
//   D-8: g-buffer fragment entry lands in default-standard-pbr.wgsl fs_gbuffer.
//   w17: forgeax::default-standard-pbr template registered in ShaderRegistry.

import {
  type MaterialAsset,
  type MaterialPassDescriptor,
  RenderQueue,
} from '@forgeax/engine-types';

/**
 * Premultiplied-alpha blend state for sprite materials (and any other
 * transparent surface that ships pre-multiplied RGB).
 *
 * Equation (per WebGPU `GPUBlendState`):
 *
 *   color_out = color_src * 1 + color_dst * (1 - alpha_src)
 *   alpha_out = alpha_src * 1 + alpha_dst * (1 - alpha_src)
 *
 * The factor pair (`srcFactor='one'` / `dstFactor='one-minus-src-alpha'`)
 * is the canonical premultiplied-alpha composite — applicable to texture
 * atlases and PNGs with premultiplied alpha. Pass it on
 * {@link MaterialPassDescriptor.renderState}.blend; the runtime treats the
 * presence of `renderState.blend` as the SSOT for transparent routing
 * (LDR-split sub-pass + back-to-front sort).
 *
 * @example AI users opt sprite materials into transparency:
 * ```ts
 * import { SPRITE_PREMULTIPLIED_ALPHA_BLEND } from '@forgeax/engine-runtime';
 *
 * const spriteMaterial: MaterialAsset = {
 *   kind: 'material',
 *   passes: [{
 *     name: 'Forward',
 *     shader: 'forgeax::sprite',
 *     renderState: { blend: SPRITE_PREMULTIPLIED_ALPHA_BLEND },
 *   }],
 *   paramValues: { baseColorTexture: textureHandle },
 * };
 * ```
 *
 * @see {@link MaterialPassDescriptor.renderState} on `@forgeax/engine-types`.
 * @see `packages/runtime/README.md` section sprite for blend preset alternatives
 *   (additive / multiply / opaque overlay).
 */
export const SPRITE_PREMULTIPLIED_ALPHA_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

const SHADOW_CASTER_PASS = {
  name: 'ShadowCaster',
  shader: 'forgeax::default-shadow-caster',
  tags: { LightMode: 'ShadowCaster' } as Record<string, string>,
  passKind: 'shadow-caster' as const,
};

interface UnlitOpts {
  castShadow?: boolean;
}

/**
 * Create an unlit material asset from a 4-component sRGB base colour.
 *
 * Returns a {@link MaterialAsset} with a Forward pass using
 * `forgeax::default-unlit` shader and `baseColor` in paramValues.
 * By default also includes a ShadowCaster pass so the entity casts
 * shadows.  Pass `{ castShadow: false }` to disable.
 *
 * @example
 * ```ts
 * const m = Materials.unlit([0.2, 0.6, 0.9, 1]);
 * assets.register<MaterialAsset>(m).unwrap();
 * ```
 */
function unlit(rgba: readonly [number, number, number, number], opts?: UnlitOpts): MaterialAsset {
  const passes: MaterialPassDescriptor[] = [
    {
      name: 'Forward',
      shader: 'forgeax::default-unlit',
      tags: { LightMode: 'Forward' },
      queue: RenderQueue.Geometry as number,
      passKind: 'forward',
    },
  ];
  if (opts?.castShadow !== false) {
    passes.push({ ...SHADOW_CASTER_PASS });
  }
  return {
    kind: 'material',
    passes,
    paramValues: { baseColor: rgba },
  };
}

interface StandardOpts {
  baseColor: readonly [number, number, number, number];
  metallic?: number;
  roughness?: number;
  emissive?: readonly [number, number, number];
  emissiveIntensity?: number;
  emissiveTexture?: number;
  baseColorTexture?: number;
  occlusionTexture?: number;
  occlusionStrength?: number;
  castShadow?: boolean;
}

/**
 * Create a standard PBR material asset with deferred + forward + shadow passes.
 *
 * Returns a {@link MaterialAsset} with three ShaderPass entries:
 *   1. GBuffer (passKind='deferred') — opaque g-buffer write via fs_gbuffer
 *   2. Forward (passKind='forward') — transparent cluster-forward via fs_main
 *   3. ShadowCaster (passKind='shadow-caster') — depth-only shadow map write
 *
 * When used with HDRP (the default render pipeline), opaque geometry routes to
 * the deferred pass and transparent geometry routes to the forward pass
 * automatically (charter P4 consistent abstraction). AI users do not need to
 * manually select passKind — calling `Materials.standard(...)` is sufficient.
 *
 * `metallic` defaults to 0, `roughness` defaults to 0.5 (glTF 2.0 spec defaults).
 *
 * @example
 * ```ts
 * const m = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1] });
 * assets.register<MaterialAsset>(m).unwrap();
 * ```
 */
function standard(opts: StandardOpts): MaterialAsset {
  const occlusionStrength = opts.occlusionStrength ?? 1;
  if (occlusionStrength < 0 || occlusionStrength > 1) {
    throw new Error(
      `Materials.standard: occlusionStrength must be in [0, 1], got ${occlusionStrength}`,
    );
  }
  const paramValues: Record<string, unknown> = {
    baseColor: opts.baseColor,
    metallic: opts.metallic ?? 0,
    roughness: opts.roughness ?? 0.5,
    occlusionStrength,
  };
  if (opts.emissive !== undefined) paramValues.emissive = opts.emissive;
  if (opts.emissiveIntensity !== undefined) paramValues.emissiveIntensity = opts.emissiveIntensity;
  if (opts.emissiveTexture !== undefined) paramValues.emissiveTexture = opts.emissiveTexture;
  if (opts.baseColorTexture !== undefined) paramValues.baseColorTexture = opts.baseColorTexture;
  if (opts.occlusionTexture !== undefined) paramValues.occlusionTexture = opts.occlusionTexture;
  // feat-20260612-hdrp-deferred-shading M3 / w15: 3-pass literal declaration.
  // Pass 1: deferred opaque — writes g-buffer (fs_gbuffer entry per D-8).
  // Pass 2: forward transparent — cluster-forward GGX (fs_main entry).
  // Pass 3: shadow-caster — depth-only shadow map write.
  // HDRP execute selects pass by passKind + material alpha-blend state (D-4).
  const passes: MaterialPassDescriptor[] = [
    {
      name: 'GBuffer',
      shader: 'forgeax::default-standard-pbr',
      fragmentEntry: 'fs_gbuffer',
      tags: { LightMode: 'Deferred' },
      queue: RenderQueue.Geometry as number,
      passKind: 'deferred',
    },
    {
      name: 'Forward',
      shader: 'forgeax::default-standard-pbr',
      fragmentEntry: 'fs_main',
      tags: { LightMode: 'Forward' },
      queue: RenderQueue.Geometry as number,
      passKind: 'forward',
    },
  ];
  if (opts.castShadow !== false) {
    passes.push({ ...SHADOW_CASTER_PASS });
  }
  return {
    kind: 'material',
    passes,
    paramValues,
  };
}

/**
 * Materials namespace: static factory functions for creating material asset
 * payloads without writing full POJOs by hand.
 *
 * Two member functions: {@link unlit} and {@link standard}.
 * Both include a ShadowCaster pass by default ({@link castShadow} defaults to
 * `true`); pass `{ castShadow: false }` to disable shadow casting.
 *
 * @example Single import:
 * ```ts
 * import { Materials } from '@forgeax/engine-runtime';
 * const unlitWhite = Materials.unlit([1, 1, 1, 1]);
 * const standardPbr = Materials.standard({ baseColor: [0.5, 0.5, 0.5, 1], baseColorTexture: unwrapHandle(tex) });
 * ```
 */
export const Materials = {
  unlit,
  standard,
} as const;

import type { MaterialCookRasterContext } from '@forgeax/engine-pack/material-cook';
import type { RhiCaps } from '@forgeax/engine-rhi';

/** The receiving device selects the immutable material program domain. */
export function renderMaterialContext(
  caps: Pick<RhiCaps, 'backendKind' | 'storageBuffer'>,
  visibleSurface = false,
): {
  readonly materialContext?: MaterialCookRasterContext;
} {
  if (caps.backendKind === 'null') return {};
  return {
    materialContext: {
      backend: caps.backendKind === 'wgpu-webgl2' ? 'webgl2' : caps.backendKind,
      capability: caps.storageBuffer ? 'storage-buffer' : 'uniform-fallback',
      pipeline: 'forward',
      geometry: 'mesh',
      pass: 'forward',
      profile: 'forgeax-material-wgsl-v1',
      toolchain: 'naga-oil',
      instrumentation: 'none',
      ...(visibleSurface ? { visibleSurface: true } : {}),
    },
  };
}

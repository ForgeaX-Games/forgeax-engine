import type { MipmapShaderModuleFactory } from '@forgeax/engine-assets-runtime';
import type { RhiDevice } from '@forgeax/engine-rhi';
import type { GpuResidencyCache } from '../device/gpu-residency';
import type { RhiBackendPack } from './backend-contract';
import { MIPMAP_PREWARM_FORMATS } from './webgpu-ready-contract';

export function adaptMipmapShaderModuleFactory(
  factory: RhiBackendPack['createShaderModule'],
): MipmapShaderModuleFactory | undefined {
  if (factory === undefined) return undefined;
  return (device, descriptor) => factory(device as RhiDevice, descriptor);
}

/**
 * Prewarm the mipmap pipeline while the renderer is still on its async ready
 * path. A manifest-free camera-only renderer must not create the shader.
 */
export async function prewarmMipmapPipeline(
  rhiDevice: RhiDevice,
  gpuStore: GpuResidencyCache,
  hasMaterialManifest: boolean,
): Promise<void> {
  if (!hasMaterialManifest) return;
  const result = await gpuStore.prewarmMipmapPipeline(rhiDevice, MIPMAP_PREWARM_FORMATS);
  if (!result.ok) throw result.error;
}

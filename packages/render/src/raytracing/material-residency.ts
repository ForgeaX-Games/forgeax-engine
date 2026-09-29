import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { Sampler, Texture, TextureView } from '@forgeax/engine-rhi';
import type { ShaderRegistry } from '@forgeax/engine-shader';
import { ok, type SamplerAsset, type TextureAsset } from '@forgeax/engine-types';
import type { GpuResidencyCache, TextureResidencyReceipt } from '../device/gpu-residency';
import type { ResidencyLease } from '../device/residency-lifetime';
import type { RenderResourceScope } from '../publication/resource-scope';
import type { MaterialSnapshot } from '../render-system-extract';
import { rayReferenceFailure } from './scene';

/** Retain accepted static allocations through the Renderer residency owner.
 * Track each submission, then release on cancellation, replacement or disposal. */
export function prepareRayMaterialTextures(
  store: GpuResidencyCache,
  defaultSampler: Sampler,
  shaders: ShaderRegistry,
  world: RenderResourceScope,
  snapshot: MaterialSnapshot,
) {
  if (snapshot.materialRay === undefined)
    return rayReferenceFailure('material has no accepted ray program');
  const shader = shaders.findMaterialArtifact(snapshot.materialRay.programKey);
  if (!shader.ok) return shader;
  const textures = new Map<
    string,
    {
      view: TextureView;
      sampler: Sampler;
      texture: Texture;
      receipt: TextureResidencyReceipt;
    }
  >();
  const leases: ResidencyLease[] = [];
  let accepted = false;
  try {
    for (const parameter of shader.value.paramSchema) {
      if (parameter.type !== 'texture2d') continue;
      const name = parameter.name;
      if (snapshot.textureSources?.has(name) || snapshot.videoTextureFields?.has(name))
        return rayReferenceFailure(`ray texture ${name} requires a qualified dynamic source`);
      const handle = snapshot.textureHandles?.get(name);
      if (handle === undefined || handle === 0)
        return rayReferenceFailure(`ray texture ${name} has no accepted resource handle`);
      const asset = resolveAssetHandle<TextureAsset>(world, handle);
      if (!asset.ok) return asset;
      const resident = store.ensureResident(handle, asset.value, world);
      if (!resident.ok) return resident;
      const lease = store.retainTextureResidency(handle, world);
      if (lease === undefined) return rayReferenceFailure(`ray texture ${name} lost residency`);
      leases.push(lease);
      let sampler = defaultSampler;
      const samplerHandle = snapshot.samplerHandles?.get(name);
      if (samplerHandle !== undefined && samplerHandle !== 0) {
        const asset = resolveAssetHandle<SamplerAsset>(world, samplerHandle);
        if (!asset.ok) return asset;
        const resident = store.ensureSamplerResident(samplerHandle, asset.value, world);
        if (!resident.ok) return resident;
        sampler = resident.value;
      } else if (snapshot.authoredSamplerFields?.has(name)) {
        return rayReferenceFailure(`ray texture ${name} has no accepted sampler handle`);
      }
      textures.set(name, {
        view: resident.value.view,
        sampler,
        texture: resident.value.texture.handle,
        receipt: resident.value.receipt,
      });
    }
    accepted = true;
    return ok({
      textures,
      track: (completed: Promise<unknown>) => {
        for (const lease of leases) lease.track(completed);
      },
      release: async () => {
        await Promise.all(leases.map((lease) => lease.release(false)));
      },
    });
  } finally {
    if (!accepted) for (const lease of leases) lease.release(false);
  }
}

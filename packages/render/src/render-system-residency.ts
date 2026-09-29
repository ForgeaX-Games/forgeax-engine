import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import {
  deriveTextureLayout,
  type MaterialAsset,
  type SamplerAsset,
  type TextureAsset,
  toShared,
} from '@forgeax/engine-types';
import type {
  MeshMaterialBindingPreparationFailure,
  MeshMaterialBindingResidency,
} from './mesh-material-bindings';
import type { RenderResourceScope } from './publication/resource-scope';
import type { RenderSystemInternals } from './record/render-context';
import { materialSamplerHandles, materialTextureHandles } from './recovery/render-system-candidate';
import type { MaterialSnapshot } from './render-system-extract';

function preparationFailureFrom(error: unknown): MeshMaterialBindingPreparationFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value = error as {
    readonly code?: unknown;
    readonly expected?: unknown;
    readonly hint?: unknown;
    readonly detail?: unknown;
  };
  if (
    typeof value.code !== 'string' ||
    typeof value.expected !== 'string' ||
    typeof value.hint !== 'string'
  ) {
    return undefined;
  }
  const detail =
    typeof value.detail === 'object' && value.detail !== null
      ? { ...(value.detail as Record<string, unknown>) }
      : undefined;
  return {
    code: value.code,
    expected: value.expected,
    hint: value.hint,
    ...(detail === undefined ? {} : { detail }),
  };
}

/**
 * Project producer-owned material and GPU-store state into the renderer's one
 * observation surface. This is recomputed from detached frame snapshots; no
 * readiness map is retained by RenderSystem. A producer failure with an
 * already resident resource remains last-known-good.
 */
export function observeMaterialResidency(
  world: RenderResourceScope | undefined,
  material: MaterialSnapshot,
  internals: RenderSystemInternals,
): MeshMaterialBindingResidency {
  const textures: Array<{ readonly handle: number; readonly mipLevelCount: number }> = [];
  const samplers: Array<{ readonly handle: number; readonly resident: boolean }> = [];
  let pending = false;
  let resident = false;
  let failure: MeshMaterialBindingPreparationFailure | undefined;
  const keepFailure = (error: unknown): void => {
    if (failure === undefined) failure = preparationFailureFrom(error);
  };

  if (world === undefined) {
    pending = true;
  } else {
    const materialHandle = material.materialHandle;
    if (materialHandle !== undefined && materialHandle !== 0) {
      const materialResult = resolveAssetHandle<MaterialAsset>(
        world,
        toShared<'MaterialAsset'>(materialHandle),
      );
      if (!materialResult.ok) {
        keepFailure(materialResult.error);
      } else {
        const guid = internals.assets.guidOf(materialResult.value);
        if (guid !== undefined) {
          const readiness = internals.assets.getMaterialReadiness(guid);
          if (readiness?.status === 'Error') keepFailure(readiness.error);
          const load = internals.assets.loadState.get(guid);
          if (load?.status === 'provisional') pending = true;
        }
      }
    }

    for (const handle of materialTextureHandles(material)) {
      const existing = internals.gpuStore.getTextureGpuView(handle, world);
      const pod = resolveAssetHandle<TextureAsset>(world, handle);
      if (!pod.ok) {
        keepFailure(pod.error);
        continue;
      }
      let view = existing;
      if (view === undefined) {
        const prepared = internals.gpuStore.ensureResident(handle, pod.value, world);
        if (!prepared.ok) keepFailure(prepared.error);
        view = internals.gpuStore.getTextureGpuView(handle, world);
      }
      if (view === undefined) {
        pending = failure === undefined;
        continue;
      }
      const textureLayout = deriveTextureLayout({
        shape: pod.value.shape,
        format: pod.value.format,
        mips: pod.value.mips,
      });
      if (!textureLayout.ok) {
        keepFailure(textureLayout.error);
        continue;
      }
      resident = true;
      textures.push({
        handle: Number(handle),
        mipLevelCount: Math.max(1, textureLayout.value.levels.length),
      });
    }

    for (const handle of materialSamplerHandles(material)) {
      const pod = resolveAssetHandle<SamplerAsset>(world, handle);
      if (!pod.ok) {
        keepFailure(pod.error);
        samplers.push({ handle: Number(handle), resident: false });
        continue;
      }
      const prepared = internals.gpuStore.ensureSamplerResident(handle, pod.value, world);
      if (!prepared.ok) {
        keepFailure(prepared.error);
        samplers.push({ handle: Number(handle), resident: false });
      } else {
        resident = true;
        samplers.push({ handle: Number(handle), resident: true });
      }
    }
    // Video views are supplied by the renderer-owned dynamic store at record
    // time. A previously uploaded view is a producer-owned last-known-good
    // fact; absence means the visible workset still needs a decodable frame.
    for (const clip of material.videoTextureFields?.values() ?? []) {
      if (internals.dynamicTextureStore?.getView(clip) === undefined) pending = true;
      else resident = true;
    }
  }

  const readiness =
    failure === undefined
      ? pending
        ? 'pending'
        : 'ready'
      : resident
        ? 'last-known-good'
        : 'failed';
  return {
    readiness,
    samplers,
    textures,
    ...(failure === undefined ? {} : { preparationFailure: failure }),
  };
}

import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  buildPerSubmeshMaterialBg,
  type PerSubmeshMaterialBgDeps,
} from '../record/main-pass-material';

const SHA_MEDIUM_SHADER = 'sha256:464bbf-single-layer-medium';

interface TestBindGroupEntry {
  readonly binding: number;
}

interface TestDependencies extends PerSubmeshMaterialBgDeps {
  readonly bindGroupEntries: Array<readonly TestBindGroupEntry[]>;
}

function dependencies(
  options: { readonly selectedShader?: string; readonly surfaceResources?: boolean } = {},
): TestDependencies {
  const resource = () => ({}) as never;
  const bindGroupEntries: Array<readonly TestBindGroupEntry[]> = [];
  const runtime = {
    device: {
      caps: { storageBuffer: false },
      limits: { maxSampledTexturesPerShaderStage: 16 },
      createBindGroup: (descriptor: { readonly entries: readonly TestBindGroupEntry[] }) => {
        bindGroupEntries.push(descriptor.entries);
        return { ok: true, value: resource() };
      },
    },
    ...(options.selectedShader === SHA_MEDIUM_SHADER
      ? {
          getMaterialShaderArtifact: (shaderId: string) =>
            shaderId === SHA_MEDIUM_SHADER
              ? ({ receipt: { surface: { model: 'single-layer-medium' } } } as never)
              : undefined,
        }
      : {}),
  };
  const pipelineState = {
    materialBindGroupLayout: resource(),
    materialUniformBuffer: { buffer: resource() },
    meshStorageBuffer: { buffer: resource() },
    viewUniformBuffer: resource(),
    defaultSampler: resource(),
    defaultWhiteTextureView: resource(),
    defaultNormalTextureView: resource(),
    fallbackTextureView: resource(),
    defaultAnisotropyTextureView: resource(),
    ...(options.surfaceResources ? { surfaceMediumDepthSampler: resource() } : {}),
  };
  const deps = {
    runtime,
    pipelineState,
    world: new World(),
    store: { materialResourceEpoch: 0 },
    materialSlice: 256,
    videoHighPerfAvailable: false,
    skylightResources: {
      irradianceView: resource(),
      irradianceSampler: resource(),
      prefilterView: resource(),
      skylightPrefilterView: resource(),
      prefilterSampler: resource(),
      brdfLutView: resource(),
      intensityBuffer: resource(),
    },
    materialBgShared: new Map(),
    materialBgAssemblyCache: new Map(),
    bindGroupCounts: { createBindGroup: 0, keys: [] },
    frameState: {},
    ...(options.surfaceResources
      ? {
          surfaceRawDepthView: resource(),
          surfaceNearestLayerView: resource(),
          surfaceNearestDepthView: resource(),
        }
      : {}),
    bindGroupEntries,
  };
  return deps as unknown as TestDependencies;
}

function mediumSnapshot() {
  return {
    materialShaderId: 'forgeax::selected-shadow',
    surfaceModel: 'single-layer-medium',
  } as never;
}

describe('main-pass Surface material selection', () => {
  it('does not request raw depth when a non-medium pass shader is selected', () => {
    expect(() =>
      buildPerSubmeshMaterialBg(
        dependencies(),
        mediumSnapshot(),
        4,
        undefined,
        'forgeax::selected-shadow',
      ),
    ).not.toThrow();
  });

  it('requires raw depth for the selected single-layer-medium shader', () => {
    expect(() =>
      buildPerSubmeshMaterialBg(
        dependencies(),
        mediumSnapshot(),
        4,
        undefined,
        'forgeax::single-layer-medium',
      ),
    ).toThrow('single-layer medium material bind group has producer-owned raw depth');
  });

  it('uses the selected SHA medium artifact ABI instead of authored metadata', () => {
    const missingResources = dependencies({ selectedShader: SHA_MEDIUM_SHADER });
    expect(() =>
      buildPerSubmeshMaterialBg(
        missingResources,
        mediumSnapshot(),
        4,
        undefined,
        SHA_MEDIUM_SHADER,
      ),
    ).toThrow('single-layer medium material bind group has producer-owned raw depth');

    const completeResources = dependencies({
      selectedShader: SHA_MEDIUM_SHADER,
      surfaceResources: true,
    });
    expect(() =>
      buildPerSubmeshMaterialBg(
        completeResources,
        mediumSnapshot(),
        4,
        undefined,
        SHA_MEDIUM_SHADER,
      ),
    ).not.toThrow();
    const entries = completeResources.bindGroupEntries[0] ?? [];
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some(({ binding }) => binding === 47)).toBe(false);
  });
});

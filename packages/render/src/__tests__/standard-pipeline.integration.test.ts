import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { standardPipeline } from '../pipeline/standard-pipeline';
import {
  DEFAULT_STANDARD_PROFILE,
  STANDARD_PIPELINE_ID,
  type StandardProfile,
} from '../pipeline/standard-profile';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';

function topology(
  profile: StandardProfile,
  overrides: Partial<RenderPipelineTopology> = {},
): RenderPipelineTopology {
  return {
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: profile,
    config: profile.ssao ? { ssao: { enabled: true } } : undefined,
    surface: {
      width: 1,
      height: 1,
      storageFormat: 'bgra8unorm',
      viewFormat: 'bgra8unorm-srgb',
    },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom: 'on' },
    shadow: {
      mapSize: 64,
      cascadeCount: 1,
      pointCount: 0,
      pointFaceSize: 64,
      spotCount: 0,
    },
    lane: {
      compute: true,
      storageBuffer: true,
      multisample: false,
      maxColorAttachments: 8,
    },
    featureTopologySignature: 'none',
    gpuDrivenTopologySignature: '',
    ...overrides,
  };
}

let device: RhiDevice;

beforeAll(async () => {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const created = await adapter.value.requestDevice();
  if (!created.ok) throw created.error;
  device = created.value;
});

async function build(profile: StandardProfile, overrides?: Partial<RenderPipelineTopology>) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const built = standardPipeline.build(
    {
      graph,
      projectGpuDriven: () => ok(undefined),
      contributeFeatures: () => ok(undefined),
    },
    topology(profile, overrides),
  );
  if (!built.ok) return built;
  return graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
}

describe('forgeax::standard graph', () => {
  it.each([
    ['direct-1', { ...DEFAULT_STANDARD_PROFILE, lightCount: 1, lighting: 'direct' }],
    ['clustered-32', { ...DEFAULT_STANDARD_PROFILE, lightCount: 32, lighting: 'clustered' }],
    ['clustered-256', { ...DEFAULT_STANDARD_PROFILE, lightCount: 256, lighting: 'clustered' }],
  ] as const)('preserves the %s light lane under one identity', async (_name, profile) => {
    const result = await build(profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inspect().passes.length).toBeGreaterThan(0);
  });

  it('keeps shadow, lighting, post, and debug work in one ordered graph', async () => {
    const result = await build({ ...DEFAULT_STANDARD_PROFILE, lighting: 'clustered' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    const stages = [
      'shadowCascade-0',
      'g-buffer',
      'lighting',
      'forward',
      'tonemap',
      'debug-overlay',
    ];
    for (let index = 1; index < stages.length; index += 1) {
      expect(names.indexOf(stages[index] ?? '')).toBeGreaterThan(
        names.indexOf(stages[index - 1] ?? ''),
      );
    }
  });

  it('uses the CPU/WebGL2 fallback without clustered resources', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, lighting: 'clustered' },
      {
        lane: {
          compute: false,
          storageBuffer: false,
          multisample: false,
          maxColorAttachments: 4,
        },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    expect(names).not.toContain('cluster-membership-producer');
    expect(result.value.inspect().resources.map((resource) => resource.label)).not.toContain(
      'hdrp-light-index-list',
    );
  });
});

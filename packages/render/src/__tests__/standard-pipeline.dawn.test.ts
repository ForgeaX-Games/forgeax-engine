import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-webgpu';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { DEFAULT_STANDARD_PROFILE, STANDARD_PIPELINE_ID } from '../pipeline/standard-profile';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';

function topology(): RenderPipelineTopology {
  return {
    pipelineId: STANDARD_PIPELINE_ID,
    standardProfile: { ...DEFAULT_STANDARD_PROFILE, lighting: 'clustered', lightCount: 256 },
    config: { ssao: { enabled: true } },
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
  };
}

describe('forgeax::standard graph on a real WebGPU device', () => {
  it('compiles the clustered profile with real texture and binding formats', async () => {
    const adapter = (await rhi.requestAdapter()).unwrap();
    const device: RhiDevice = (await adapter.requestDevice()).unwrap();
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const built = standardPipeline.build(
      {
        graph,
        projectGpuDriven: () => ok(undefined),
        contributeFeatures: () => ok(undefined),
      },
      topology(),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const compiled = graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
    expect(compiled.ok).toBe(true);
    if (compiled.ok) {
      expect(compiled.value.inspect().passes.map((pass) => pass.kind)).toContain('compute');
    }
  });
});

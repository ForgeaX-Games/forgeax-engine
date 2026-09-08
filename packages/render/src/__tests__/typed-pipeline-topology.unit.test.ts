import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { standardPipeline } from '../pipeline/standard-pipeline';
import { DEFAULT_STANDARD_PROFILE } from '../pipeline/standard-profile';
import type {
  RenderPipeline,
  RenderPipelineFrame,
  RenderPipelineTopology,
} from '../render-pipeline';

let device: RhiDevice;

beforeAll(async () => {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const created = await adapter.value.requestDevice();
  if (!created.ok) throw created.error;
  device = created.value;
});

function topology(
  pipelineId: 'forgeax::standard',
  overrides: Partial<RenderPipelineTopology> = {},
): RenderPipelineTopology {
  return {
    pipelineId,
    config: undefined,
    surface: {
      width: 800,
      height: 600,
      storageFormat: 'bgra8unorm',
      viewFormat: 'bgra8unorm-srgb',
    },
    camera: { tonemap: 'aces-filmic', antialias: 'fxaa', bloom: 'on' },
    shadow: {
      mapSize: 1024,
      cascadeCount: 4,
      pointCount: 1,
      pointFaceSize: 512,
      spotCount: 1,
    },
    lane: {
      compute: true,
      storageBuffer: true,
      multisample: true,
      maxColorAttachments: 8,
    },
    featureTopologySignature: 'none',
    gpuDrivenTopologySignature: '',
    ...overrides,
  };
}

function compile(pipeline: RenderPipeline, input: RenderPipelineTopology) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const built = pipeline.build(
    {
      graph,
      projectGpuDriven: () => ok(undefined),
      contributeFeatures: () => ok(undefined),
    },
    input,
  );
  if (!built.ok) return built;
  return graph.compile({
    device,
    surfaceSize: { width: input.surface.width, height: input.surface.height },
  });
}

describe('typed built-in pipeline topology', () => {
  it('orders HDRP compute, shadow, deferred, SSAO, forward, observation, and output work', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, lighting: 'clustered', ssao: true },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const ordered = [
      'cluster-membership-producer',
      'g-buffer',
      'ssao-calc',
      'ssao-blur',
      'lighting',
      'forward',
      'linear-hdr-observation',
      'tonemap',
    ];
    for (let index = 1; index < ordered.length; index += 1) {
      expect(names.indexOf(ordered[index] ?? '')).toBeGreaterThan(
        names.indexOf(ordered[index - 1] ?? ''),
      );
    }
    expect(names.filter((name) => name.startsWith('point-shadow-'))).toHaveLength(6);
    expect(names.filter((name) => name.startsWith('shadowCascade'))).toHaveLength(4);

    const membership = info.passes.find((pass) => pass.name === 'cluster-membership-producer');
    expect(membership?.kind).toBe('compute');
    expect(membership?.accesses).toContainEqual({
      resource: 'hdrp-light-index-list',
      usage: 'storage-write',
    });
    const lighting = info.passes.find((pass) => pass.name === 'lighting');
    expect(lighting?.accesses).toEqual(
      expect.arrayContaining([
        { resource: 'gbuffer-normal-roughness', usage: 'sampled-read' },
        { resource: 'gbuffer-albedo-metallic', usage: 'sampled-read' },
        { resource: 'gbuffer-emissive-ao', usage: 'sampled-read' },
        { resource: 'ssao-blurred', usage: 'sampled-read' },
        { resource: 'hdrp-scene-color', usage: 'color-attachment' },
      ]),
    );
  });

  it('omits SSAO and compute membership on the bounded fallback lane', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, lighting: 'clustered' },
        config: { ssao: { enabled: false } },
        lane: {
          compute: false,
          storageBuffer: false,
          multisample: false,
          maxColorAttachments: 8,
        },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const names = compiled.value.inspect().passes.map((pass) => pass.name);
    expect(names).not.toContain('cluster-membership-producer');
    expect(names.some((name) => name.startsWith('ssao-'))).toBe(false);
  });

  it('keeps URP post effects after output and before debug overlay', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        config: { postEffects: ['example::a', 'example::b'] },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names.filter((name) => name.startsWith('shadowCascade'))).toHaveLength(4);
    expect(names.indexOf('post-effect-0')).toBeGreaterThan(names.indexOf('fxaa'));
    expect(names.indexOf('post-effect-1')).toBeGreaterThan(names.indexOf('post-effect-0'));
    expect(names.indexOf('debug-overlay')).toBeGreaterThan(names.indexOf('post-effect-1'));
    expect(info.resources.map((resource) => resource.label)).toEqual(
      expect.arrayContaining([
        'post-effect-scratch-0',
        'post-effect-output-0',
        'post-effect-scratch-1',
      ]),
    );
    const copy0 = info.passes.find((pass) => pass.name === 'post-effect-copy-0');
    const effect0 = info.passes.find((pass) => pass.name === 'post-effect-0');
    const copy1 = info.passes.find((pass) => pass.name === 'post-effect-copy-1');
    const effect1 = info.passes.find((pass) => pass.name === 'post-effect-1');
    expect(copy0?.accesses).toContainEqual({ resource: 'surface', usage: 'copy-src' });
    expect(copy1?.accesses).toContainEqual({
      resource: 'post-effect-output-0',
      usage: 'copy-src',
    });
    expect(effect0?.accesses).toContainEqual({
      resource: 'post-effect-output-0',
      usage: 'color-attachment',
    });
    expect(effect1?.accesses).toContainEqual({
      resource: 'surface',
      usage: 'color-attachment',
    });
    expect(copy1?.dependencies).toContain('post-effect-0');
    expect(effect1?.dependencies).toContain('post-effect-copy-1');
  });

  it('removes unsupported MSAA and composite post work on the fallback lane', () => {
    const compiled = compile(
      standardPipeline,
      topology('forgeax::standard', {
        camera: { tonemap: 'none', antialias: 'msaa', bloom: 'off' },
        config: { postEffects: ['example::a'] },
        lane: {
          compute: false,
          storageBuffer: false,
          multisample: false,
          maxColorAttachments: 4,
        },
      }),
    );
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const info = compiled.value.inspect();
    expect(info.resources.some((resource) => resource.label.includes('msaa'))).toBe(false);
    expect(info.passes.some((pass) => pass.name.startsWith('post-effect-'))).toBe(false);
  });

  it('returns a structured HDRP capability refusal before graph compilation', () => {
    const built = compile(
      standardPipeline,
      topology('forgeax::standard', {
        standardProfile: { ...DEFAULT_STANDARD_PROFILE, lighting: 'clustered' },
        lane: {
          compute: true,
          storageBuffer: true,
          multisample: true,
          maxColorAttachments: 3,
        },
      }),
    );
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.error.code).toBe('hdrp-deferred-caps-insufficient');
  });
});

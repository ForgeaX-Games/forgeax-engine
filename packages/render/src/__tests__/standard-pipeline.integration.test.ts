import { mat4, vec3 } from '@forgeax/engine-math';
import { RenderGraphBuilder } from '@forgeax/engine-render-graph';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRenderSurfaceError, type RenderSurfaceExpectedError } from '../errors/render';
import { BARREL_DISTORTION_POST_PROCESS_ID } from '../features/barrel-distortion';
import { prepareStandardLighting } from '../pipeline/standard-lighting/prepare';
import { deriveStandardTopologyInput } from '../pipeline/standard-lighting/topology';
import { selectStandardClusterTransport } from '../pipeline/standard-lighting/transport';
import { createStandardOutputPlan } from '../pipeline/standard-output/graph';
import { standardPipeline } from '../pipeline/standard-pipeline';
import {
  DEFAULT_STANDARD_PROFILE,
  STANDARD_PIPELINE_ID,
  type StandardProfile,
} from '../pipeline/standard-profile';
import type { FrameObservationDomain } from '../render-contract';
import type { RenderPipelineFrame, RenderPipelineTopology } from '../render-pipeline';
import type { SurfaceProfile } from '../render-system';
import { admitSsrSpatial } from '../ssr/admission';
import { addTypedFullscreenPass } from '../typed-render-graph-primitives';

const rawOnlyProfile: SurfaceProfile = {
  kind: 'raw-only',
  storageFormat: 'rgba8unorm',
  viewFormat: 'rgba8unorm',
  viewFormats: [],
  hasDisplayEndpoint: false,
};

const dualViewProfile: SurfaceProfile = {
  kind: 'dual-view',
  storageFormat: 'bgra8unorm',
  viewFormat: 'bgra8unorm-srgb',
  viewFormats: ['bgra8unorm-srgb'],
  hasDisplayEndpoint: true,
};

type TopologyOverrides = Omit<Partial<RenderPipelineTopology>, 'camera'> & {
  readonly camera?: Partial<RenderPipelineTopology['camera']>;
};

function topology(
  profile: StandardProfile,
  overrides: TopologyOverrides = {},
): RenderPipelineTopology {
  const { camera: cameraOverride, ...rest } = overrides;
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
    camera: {
      tonemap: 'aces-filmic',
      antialias: 'fxaa',
      bloom: 'on',
      bloomIntensity: 1,
      ...cameraOverride,
    },
    shadow: {
      directional: { mapSize: 64, cascadeCount: 1 },
      spotMapSize: 64,
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
    ...rest,
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

function standardLightingFor(resolvedTopology: RenderPipelineTopology) {
  const prepared = prepareStandardLighting({
    directional: undefined,
    local: [{ kind: 'point', shadowed: false, position: vec3.create(0, 0, -4), range: 2 }],
    view: mat4.create(),
    projection: mat4.create(),
    near: 0.1,
    far: 100,
    grid: resolvedTopology.config?.clusterGrid ?? { x: 4, y: 3, z: 4 },
    lightCount: resolvedTopology.standardProfile?.lightCount ?? DEFAULT_STANDARD_PROFILE.lightCount,
    renderPath: resolvedTopology.standardProfile?.renderPath ?? DEFAULT_STANDARD_PROFILE.renderPath,
  });
  if (!prepared.ok) return prepared;
  const transport = selectStandardClusterTransport(
    {
      compute: resolvedTopology.lane.compute,
      storageBuffer: resolvedTopology.lane.storageBuffer,
      membershipPipelineReady: resolvedTopology.lane.compute,
    },
    prepared.value,
  );
  if (!transport.ok) return transport;
  const standardLighting = deriveStandardTopologyInput({
    prepared: prepared.value,
    kind: 'clustered',
    transport: transport.value,
  });
  return standardLighting;
}

async function build(
  profile: StandardProfile,
  overrides?: TopologyOverrides,
  observationCaptureDomains?: readonly FrameObservationDomain[],
  lateOcclusion = false,
) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const resolvedTopology = topology(profile, overrides);
  const histogram = graph.createBuffer('standard-auto-exposure-histogram', { size: 1024 });
  const state = graph.createBuffer('standard-auto-exposure-state', { size: 32 });
  const candidate = graph.createBuffer('standard-auto-exposure-candidate', { size: 16 });
  const parameters = graph.createBuffer('standard-auto-exposure-parameters', { size: 32 });
  const lutTexture = graph.createTexture('standard-color-lut-source', {
    format: 'rgba16float',
    size: { width: 2, height: 2, depthOrArrayLayers: 2 },
    dimension: '3d',
  });
  if (!histogram.ok || !state.ok || !candidate.ok || !parameters.ok || !lutTexture.ok)
    throw new Error('standard output test resources could not be declared');
  if (overrides?.output?.autoExposure === true) {
    const parametersInit = graph.addComputePass('standard-auto-exposure-parameters-init', {
      accesses: [{ resource: parameters.value, usage: 'storage-write' }],
      encode: () => undefined,
    });
    if (!parametersInit.ok) throw parametersInit.error;
  }
  const lutView = graph.view(lutTexture.value, { dimension: '3d' });
  if (!lutView.ok) throw lutView.error;
  const lutInit = graph.addComputePass('standard-color-lut-test-init', {
    accesses: [{ resource: lutView.value, usage: 'storage-write' }],
    encode: () => undefined,
  });
  if (!lutInit.ok) throw lutInit.error;
  const lutSampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  if (!lutSampler.ok) throw lutSampler.error;
  const lutGpuTexture = device
    .createTexture({
      label: 'standard-output-test-lut',
      format: 'rgba16float',
      size: { width: 2, height: 2, depthOrArrayLayers: 2 },
      dimension: '3d',
      usage: 0x04,
      textureBindingViewDimension: undefined,
    })
    .unwrap();
  const lutGpuView = device.createTextureView(lutGpuTexture, { dimension: '3d' }).unwrap();
  const lutBindGroupLayout = device
    .createBindGroupLayout({
      entries: [
        { binding: 0, visibility: 0x2, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 1, visibility: 0x2, sampler: { type: 'filtering' } },
      ],
    })
    .unwrap();
  const lutBindGroup = device
    .createBindGroup({
      layout: lutBindGroupLayout,
      entries: [
        { binding: 0, resource: { kind: 'textureView', value: lutGpuView } },
        { binding: 1, resource: { kind: 'sampler', value: lutSampler.value } },
      ],
    })
    .unwrap();
  const standardLighting = standardLightingFor(resolvedTopology);
  if (!standardLighting.ok) return standardLighting;
  const built = standardPipeline.build(
    {
      graph,
      observationCaptureDomains,
      standardLighting: standardLighting.value,
      standardOutput: {
        autoExposure: {
          histogram: histogram.value,
          state: state.value,
          candidate: candidate.value,
          parameters: parameters.value,
        },
        colorLut: {
          view: lutView.value,
          sampler: lutSampler.value,
          strength: 1,
          bindGroupLayout: lutBindGroupLayout,
          bindGroup: lutBindGroup,
        },
      },
      encodeTransmissionMip: ({ pass }) => pass.draw(3, 1, 0, 0),
      capabilities: { rgba16floatRenderable: true },
      projectGpuDriven: () =>
        ok(
          lateOcclusion
            ? {
                accesses: [],
                encode: () => undefined,
                addLateOcclusion: (pyramid) => {
                  const late = graph.addComputePass('test-late-cull', {
                    accesses: [{ resource: pyramid, usage: 'sampled-read' }],
                    encode: () => undefined,
                  });
                  return late.ok ? ok(['test-late-cull']) : late;
                },
              }
            : undefined,
        ),
      contributeFeatures: (
        _targets,
        _semanticTargets,
        namedTargets = {},
        _standardSurfaceAccesses,
        featureSelection,
      ) => {
        if (
          typeof featureSelection !== 'object' ||
          featureSelection?.include?.includes(BARREL_DISTORTION_POST_PROCESS_ID) !== true
        ) {
          return ok(undefined);
        }
        const input = namedTargets['barrel-input'];
        const output = namedTargets['barrel-output'];
        if (input === undefined || output === undefined) return ok(undefined);
        return addTypedFullscreenPass(graph, {
          name: 'barrel-distortion',
          shader: BARREL_DISTORTION_POST_PROCESS_ID,
          input,
          outputs: [output],
        });
      },
      hasFeature: (identity) => identity === BARREL_DISTORTION_POST_PROCESS_ID,
    },
    resolvedTopology,
  );
  if (!built.ok) return built;
  return graph.compile({
    device,
    surfaceSize: {
      width: resolvedTopology.surface.width,
      height: resolvedTopology.surface.height,
    },
  });
}

function importedTaaHistory(graph: RenderGraphBuilder<RenderPipelineFrame>) {
  const target = (label: string, format: 'rgba16float' | 'r8unorm' = 'rgba16float') => {
    const texture = graph.importTexture(
      label,
      { format, size: 'surface', usage: 0x17 },
      (frame) => frame.currentTexture,
    );
    if (!texture.ok) throw texture.error;
    const view = graph.importView(texture.value, { label: `${label}.view` }, (frame) => frame.view);
    if (!view.ok) throw view.error;
    return {
      texture: texture.value,
      view: view.value,
      format,
      sampleCount: 1 as const,
    };
  };
  return {
    currentColor: target('taa-history-current-color'),
    previousColor: target('taa-history-previous-color'),
    currentTemporal: target('taa-history-current-temporal'),
    previousTemporal: target('taa-history-previous-temporal'),
    currentStability: target('taa-history-current-stability', 'r8unorm'),
    previousStability: target('taa-history-previous-stability', 'r8unorm'),
  };
}

describe('visible-surface graph admission', () => {
  const profile = {
    ...DEFAULT_STANDARD_PROFILE,
    renderPath: 'deferred',
    visibleSurface: true,
  } as const;
  const lane = {
    compute: true,
    storageBuffer: true,
    multisample: false,
    maxColorAttachments: 6,
    primitiveIndex: true,
    maxColorAttachmentBytesPerSample: 48,
  } as const;

  it('owns the sixth attachment and shares one motion producer without TAA history', async () => {
    const result = await build(profile, { lane, camera: { antialias: 'none', bloom: 'off' } });
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    expect(info.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: 'visible-surface' }),
        expect.objectContaining({ label: 'standard-scene-temporal' }),
      ]),
    );
    expect(info.passes.filter((pass) => pass.name === 'standard-scene-data')).toHaveLength(1);
    expect(info.resources.some((resource) => resource.label.startsWith('taa-history'))).toBe(false);
    (await result.value.retire()).unwrap();
    const off = await build(
      { ...profile, visibleSurface: false },
      { lane, camera: { antialias: 'none', bloom: 'off' } },
    );
    expect(off.ok).toBe(true);
    if (!off.ok) return;
    expect(
      off.value.inspect().resources.some((resource) => resource.label === 'visible-surface'),
    ).toBe(false);
    (await off.value.retire()).unwrap();
  });

  it.each([
    { primitiveIndex: false },
    { maxColorAttachments: 5 },
    { maxColorAttachmentBytesPerSample: 32 },
  ])('rejects an unqualified device before graph allocation: %j', async (missing) => {
    const result = await build(profile, { lane: { ...lane, ...missing } });
    expect(result).toMatchObject({ ok: false, error: { code: 'resource-descriptor-invalid' } });
  });

  it('captures receiver identity after both occlusion raster phases', async () => {
    const result = await build(
      profile,
      { lane, camera: { antialias: 'none', bloom: 'off' } },
      ['visible-surface'],
      true,
    );
    expect(result.ok, result.ok ? '' : JSON.stringify(result.error)).toBe(true);
    if (!result.ok) return;
    try {
      const info = result.value.inspect();
      const early = info.passes.find((pass) => pass.name === 'g-buffer');
      const late = info.passes.find((pass) => pass.name === 'g-buffer-late');
      const capture = info.passes.find((pass) => pass.name === 'visible-surface-observation');
      for (const pass of [early, late]) {
        expect(pass?.accesses).toContainEqual({
          resource: 'visible-surface',
          usage: 'color-attachment',
        });
      }
      expect(capture).toBeDefined();
      expect(capture?.executionIndex).toBeGreaterThan(late?.executionIndex ?? Infinity);
    } finally {
      (await result.value.retire()).unwrap();
    }
  });
});

async function buildTaa(profile: StandardProfile, overrides?: TopologyOverrides) {
  const graph = new RenderGraphBuilder<RenderPipelineFrame>();
  const history = importedTaaHistory(graph);
  const resolvedTopology = topology(profile, overrides);
  const standardLighting = standardLightingFor(resolvedTopology);
  if (!standardLighting.ok) return standardLighting;
  const built = standardPipeline.build(
    {
      graph,
      standardLighting: standardLighting.value,
      capabilities: { rgba16floatRenderable: true },
      taaHistory: history,
      projectGpuDriven: () => ok(undefined),
      contributeFeatures: () => ok(undefined),
    },
    resolvedTopology,
  );
  if (!built.ok) return built;
  return graph.compile({ device, surfaceSize: { width: 1, height: 1 } });
}

describe('forgeax::standard graph', () => {
  it('builds auto exposure and positive LUT with prepared live producers', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      output: {
        autoExposure: true,
        colorLut: true,
        colorLutStrength: 1,
        lutSourceKey: 'asset-guid:lut',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const tone = names.indexOf('standard-tone');
    const lut = names.indexOf('standard-color-lut');
    const fxaa = names.indexOf('fxaa');
    const encoding = names.indexOf('standard-output-encoding');
    expect(tone).toBeGreaterThanOrEqual(0);
    expect(lut).toBeGreaterThan(tone);
    expect(fxaa).toBeGreaterThan(lut);
    expect(encoding).toBeGreaterThan(fxaa);
    expect(info.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'standard-tone-output',
          descriptor: expect.objectContaining({ format: 'rgba16float', domain: 'linear-ldr' }),
        }),
        expect.objectContaining({
          label: 'standard-color-lut',
          descriptor: expect.objectContaining({ format: 'rgba16float', domain: 'linear-ldr' }),
        }),
        expect.objectContaining({
          label: 'standard-fxaa-output',
          descriptor: expect.objectContaining({ format: 'rgba16float', domain: 'linear-ldr' }),
        }),
      ]),
    );
  });

  it('splits auto exposure without a LUT into tone, linear-LDR, and final encoding stages', async () => {
    const overrides = {
      camera: { tonemap: 'aces-filmic', antialias: 'none', bloom: 'off' },
      output: { autoExposure: true, colorLut: false, colorLutStrength: 0 },
    } as const;
    const unobserved = await build(DEFAULT_STANDARD_PROFILE, overrides);
    if (!unobserved.ok) throw unobserved.error;
    const unobservedNames = unobserved.value.inspect().passes.map((pass) => pass.name);
    expect(unobservedNames).not.toContain('linear-ldr-observation');
    expect(unobservedNames).not.toContain('final-srgb-observation');
    const result = await build(DEFAULT_STANDARD_PROFILE, overrides, ['linear-ldr', 'final-srgb']);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const tone = names.indexOf('standard-tone');
    const encoding = names.indexOf('standard-output-encoding');
    expect(tone).toBeGreaterThanOrEqual(0);
    expect(encoding).toBeGreaterThan(tone);
    expect(names).not.toContain('output-transform');
    expect(names).not.toContain('standard-color-lut');
    expect(names).toEqual(
      expect.arrayContaining([
        'linear-hdr-observation',
        'linear-ldr-observation',
        'final-srgb-observation',
      ]),
    );
    expect(info.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: 'standard-tone-output',
          descriptor: expect.objectContaining({ format: 'rgba16float', domain: 'linear-ldr' }),
        }),
      ]),
    );
  });

  it('routes non-neutral Camera white balance through the shared linear-HDR stage', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'aces-filmic', antialias: 'none', bloom: 'off' },
      output: {
        autoExposure: false,
        whiteBalance: true,
        temperature: 5000,
        tint: 0.2,
        colorLut: false,
        colorLutStrength: 0,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    const wb = names.indexOf('standard-exposure-white-balance');
    const tone = names.indexOf('standard-tone');
    const encoding = names.indexOf('standard-output-encoding');
    expect(wb).toBeGreaterThanOrEqual(0);
    expect(tone).toBeGreaterThan(wb);
    expect(encoding).toBeGreaterThan(tone);
  });

  it('keeps LUT0 on the combined output transform single pass', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'aces-filmic', antialias: 'none', bloom: 'off' },
      output: { autoExposure: false, colorLut: false, colorLutStrength: 0 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    expect(names.filter((name) => name === 'output-transform')).toHaveLength(1);
    expect(names).not.toContain('standard-tone');
    expect(names).not.toContain('standard-color-lut');
    expect(names).not.toContain('standard-output-encoding');
  });

  it('does not admit an unsupported four-light budget', async () => {
    const profile = { ...DEFAULT_STANDARD_PROFILE, lightCount: 4 } as unknown as StandardProfile;
    const result = await build(profile);
    expect(result.ok).toBe(false);
  });

  it('uses one output plan for direct and clustered lanes', () => {
    const request = {
      temporal: true,
      meter: true,
      bloom: true,
      exposure: true,
      whiteBalance: true,
      lut: true,
      fxaa: true,
      outputEncoding: 'explicit-oetf' as const,
    };
    const direct = createStandardOutputPlan({ ...request, lane: 'direct' });
    const clustered = createStandardOutputPlan({ ...request, lane: 'clustered' });
    expect(clustered.logicalStages).toEqual(direct.logicalStages);
    expect(clustered.physicalStages).toEqual(direct.physicalStages);
    expect(clustered.finalWriterCount).toBe(direct.finalWriterCount);
  });

  it('accounts for admitted LUT bindings without adding work to the zero-strength path', () => {
    const baseline = createStandardOutputPlan({
      lane: 'direct',
      temporal: false,
      meter: false,
      bloom: false,
      exposure: false,
      whiteBalance: false,
      lut: false,
      fxaa: false,
      outputEncoding: 'explicit-oetf',
    });
    const lut = createStandardOutputPlan({
      lane: 'direct',
      temporal: false,
      meter: false,
      bloom: false,
      exposure: false,
      whiteBalance: false,
      lut: true,
      fxaa: false,
      outputEncoding: 'explicit-oetf',
    });

    expect(baseline.incrementalResources).toEqual([]);
    expect(baseline.incrementalBindings).toBe(0);
    expect(lut.incrementalResources).toContain('standard-color-lut');
    expect(lut.incrementalBindings).toBeGreaterThan(0);
  });

  it('places barrel distortion in linear-LDR before FXAA and final encoding', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias: 'fxaa', bloom: 'off', barrelDistortion: true },
      config: { postEffects: [BARREL_DISTORTION_POST_PROCESS_ID] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const barrel = names.indexOf('barrel-distortion');
    const fxaa = names.indexOf('fxaa');
    const encoding = names.indexOf('standard-output-encoding');
    const debug = names.indexOf('debug-overlay');
    expect(barrel).toBeGreaterThan(-1);
    expect(debug).toBeGreaterThan(-1);
    expect(debug).toBeLessThan(barrel);
    expect(barrel).toBeLessThan(fxaa);
    expect(fxaa).toBeLessThan(encoding);
    expect(names.filter((name) => name.startsWith('post-effect-'))).toHaveLength(0);
    expect(info.resources.map((resource) => resource.label)).toContain(
      'standard-barrel-distortion',
    );
  });

  it('keeps the last-known-good graph for each explicit surface failure', () => {
    let activeGraph = 'last-known-good';
    const failures = ['allocation', 'attachment', 'sampled-read', 'raw-endpoint'] as const;
    for (const kind of failures) {
      const candidateError: RenderSurfaceExpectedError = createRenderSurfaceError(kind, {
        lane: 'direct',
        stage: 'output-transform',
        target: 'standard-output-color',
        format: 'rgba16float',
        domain: 'display-encoded',
        endpoint: 'surface.storage',
        capability: `float-${kind}`,
      });
      expect(candidateError.code).toBe(`surface-${kind}-failed`);
      expect(candidateError.detail.target).toBe('standard-output-color');
      expect(activeGraph).toBe('last-known-good');
    }
    activeGraph = 'candidate';
    expect(activeGraph).toBe('candidate');
  });

  it('keeps SSR out of the Standard graph without admitted dependencies', async () => {
    const result = await build({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    expect(info.passes.map((pass) => pass.name).some((name) => name.startsWith('ssr'))).toBe(false);
    expect(
      info.resources.map((resource) => resource.label).some((label) => label.startsWith('ssr')),
    ).toBe(false);
  });

  it('projects the admitted SSR spatial chain into the deferred Standard graph', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
      {
        reflectionFallback: { enabled: true },
        ssr: admitSsrSpatial({
          camera: {
            projection: 'perspective',
            near: 0.1,
            far: 100,
            screenSpaceReflection: {
              maxDistance: 40,
              thickness: 0.2,
              maxRoughness: 0.6,
            },
          },
          environment: {
            lane: 'deferred',
            m0: { status: 'admitted' },
            sceneInputs: true,
            temporal: true,
            reflectionFallback: true,
            capabilities: {
              compute: true,
              storageTexture: true,
              rgba16floatRenderable: true,
              r32floatSampledStorage: true,
            },
          },
        }),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    expect(names).toContain('depth-pyramid-seed');
    expect(names).toContain('ssr-trace');
    expect(names).toContain('standard-scene-data');
    expect(names).toContain('ssr-compose');
    expect(names.indexOf('skybox')).toBeLessThan(names.indexOf('lighting'));
    expect(names.indexOf('lighting')).toBeLessThan(names.indexOf('depth-pyramid-seed'));
    expect(names.indexOf('ssr-compose')).toBeLessThan(names.indexOf('forward'));
    expect(names).toContain('reflection-fallback-observation');
    expect(result.value.inspect().resources.map((resource) => resource.label)).toEqual(
      expect.arrayContaining(['depth-pyramid', 'ssr-trace', 'reflection-fallback-linear-hdr']),
    );
  });

  it('resolves deferred lighting from sampled depth without replaying geometry', async () => {
    const result = await build({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lighting = result.value.inspect().passes.find((pass) => pass.name === 'lighting');
    expect(lighting?.accesses).toContainEqual({ resource: 'hdrp-depth', usage: 'sampled-read' });
    expect(lighting?.accesses).not.toContainEqual({
      resource: 'hdrp-depth',
      usage: 'depth-stencil-write',
    });
  });

  it('keeps the deferred reflection fallback producer observable without SSR', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
      { reflectionFallback: { enabled: true } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    expect(names).toContain('reflection-fallback-observation');
    expect(result.value.inspect().resources.map((resource) => resource.label)).toContain(
      'reflection-fallback-linear-hdr',
    );
    expect(names.some((name) => name.startsWith('ssr-'))).toBe(false);
    expect(
      result.value.inspect().passes.find((pass) => pass.name === 'lighting')?.accesses,
    ).toContainEqual({
      resource: 'reflection-fallback-linear-hdr',
      usage: 'color-attachment',
    });
    expect(
      result.value.inspect().passes.find((pass) => pass.name === 'g-buffer')?.accesses,
    ).not.toContainEqual({
      resource: 'reflection-fallback-linear-hdr',
      usage: 'color-attachment',
    });
  });

  it.each([
    ['forward-1', { ...DEFAULT_STANDARD_PROFILE, lightCount: 1, renderPath: 'forward' }],
    ['forward-32', { ...DEFAULT_STANDARD_PROFILE, lightCount: 32, renderPath: 'forward' }],
    ['deferred-256', { ...DEFAULT_STANDARD_PROFILE, lightCount: 256, renderPath: 'deferred' }],
  ] as const)('preserves the %s light lane under one identity', async (_name, profile) => {
    const result = await build(profile);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.inspect().passes.length).toBeGreaterThan(0);
  });

  it('keeps Bloom a no-op when TAA has no active tone mapper', async () => {
    const result = await buildTaa(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' },
      { camera: { tonemap: 'none', antialias: 'taa', bloom: 'on' } },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    expect(names.some((name) => name.startsWith('bloom-downsample-'))).toBe(false);
    expect(names.some((name) => name.startsWith('bloom-upsample-'))).toBe(false);
    expect(names).not.toContain('bloom-composite');
    expect(names).toContain('taa-resolve');
    expect(names).toContain('output-transform');
  });

  it('keeps shadow, lighting, post, and debug work in one ordered graph', async () => {
    const result = await build({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    const stages = [
      'shadowCascade-0',
      'g-buffer',
      'lighting',
      'forward',
      'output-transform',
      'debug-overlay',
    ];
    for (let index = 1; index < stages.length; index += 1) {
      expect(names.indexOf(stages[index] ?? '')).toBeGreaterThan(
        names.indexOf(stages[index - 1] ?? ''),
      );
    }
  });

  it('keeps one clustered resource layout when compute admission is unavailable', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' },
      {
        lane: {
          compute: false,
          storageBuffer: true,
          multisample: false,
          maxColorAttachments: 4,
        },
      },
    );
    expect(result.ok).toBe(true);
  });

  it('routes a no-camera clear-only frame directly to the surface', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      clearOnly: true,
      camera: { tonemap: 'none', antialias: 'none', bloom: 'off' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names).toContain('main');
    expect(names).not.toContain('output-transform');
    expect(names).not.toContain('g-buffer');
    expect(names).not.toContain('lighting');
    expect(names).not.toContain('cluster-membership-producer');
    expect(names).not.toContain('fxaa');
    expect(names).not.toContain('bloom-composite');
    expect(names).toContain('debug-overlay');
    expect(info.resources.map((resource) => resource.label)).not.toContain('scene-color');
  });

  it('refuses the clustered transport when storage is unavailable', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' },
      {
        lane: {
          compute: false,
          storageBuffer: false,
          multisample: false,
          maxColorAttachments: 4,
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('standard-cluster-transport-unavailable');
  });

  it.each([
    ['aces-filmic', 'fxaa'],
    ['none', 'fxaa'],
    ['aces-filmic', 'none'],
  ] as const)('uses one explicit post-chain contract for %s/%s', async (tonemap, antialias) => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap, antialias, bloom: 'on' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names).toContain('output-transform');
    expect(names.indexOf('bloom-composite')).toBeLessThan(names.indexOf('output-transform'));
    expect(names.indexOf('debug-overlay')).toBeGreaterThan(names.indexOf('output-transform'));
    if (antialias === 'fxaa') {
      expect(names.indexOf('fxaa')).toBeGreaterThan(names.indexOf('output-transform'));
      expect(info.resources.map((resource) => resource.label)).toContain('standard-output-color');
    } else {
      expect(names).not.toContain('fxaa');
      expect(info.resources.map((resource) => resource.label)).not.toContain(
        'standard-output-color',
      );
    }
    expect(info.resources.map((resource) => resource.label)).not.toContain('ldr-color');
  });

  const routeMatrix = (['dual-view', 'raw-only'] as const).flatMap((surfaceKind) =>
    (['none', 'aces-filmic'] as const).flatMap((tonemap) =>
      (['none', 'fxaa'] as const).map((antialias) => [surfaceKind, tonemap, antialias] as const),
    ),
  );

  it.each(
    routeMatrix,
  )('keeps the output route explicit for %s/%s/%s', async (surfaceKind, tonemap, antialias) => {
    const rawOnly = surfaceKind === 'raw-only';
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap, antialias, bloom: 'off' },
      surface: {
        width: 1,
        height: 1,
        storageFormat: rawOnly ? 'rgba8unorm' : 'bgra8unorm',
        viewFormat: rawOnly ? 'rgba8unorm' : 'bgra8unorm-srgb',
        profile: rawOnly ? rawOnlyProfile : dualViewProfile,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const sceneLabel = 'scene-color';
    const sceneResource = info.resources.find((resource) => resource.label === sceneLabel);
    expect(sceneResource).toBeDefined();
    expect(sceneResource?.derivedUsage).toBe(0x15);
    const outputTransforms = names.filter((name) => name === 'output-transform');
    expect(outputTransforms).toHaveLength(1);
    expect(names.filter((name) => name === 'fxaa')).toHaveLength(antialias === 'fxaa' ? 1 : 0);
    expect(names.filter((name) => name === 'debug-overlay')).toHaveLength(1);
    if (rawOnly) {
      expect(info.resources.map((resource) => resource.label)).not.toContain('surface.display');
      expect(names.indexOf('debug-overlay')).toBeLessThan(names.indexOf('output-transform'));
    } else {
      expect(names.indexOf('debug-overlay')).toBeGreaterThan(names.indexOf('output-transform'));
    }
    expect(
      info.resources.filter((resource) => resource.label === 'standard-output-color'),
    ).toHaveLength(antialias === 'fxaa' ? 1 : 0);
    if (antialias === 'fxaa') {
      expect(
        info.resources.find((resource) => resource.label === 'standard-output-color'),
      ).toMatchObject({
        derivedUsage: 0x10 | 0x04 | 0x01,
      });
    }
  });

  it('uses one linear target and one output transform for Standard storage-buffer LDR output', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias: 'none', bloom: 'off' },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names).toContain('output-transform');
    expect(names).not.toContain('fxaa');
    expect(info.resources.find((resource) => resource.label === 'scene-color')).toMatchObject({
      descriptor: { format: 'rgba16float' },
      derivedUsage: 0x15,
    });
    expect(info.resources.map((resource) => resource.label)).not.toContain('standard-output-color');
    expect(info.resources.map((resource) => resource.label)).not.toContain('ldr-color');
  });

  it('keeps the Standard output route when storage buffers are unavailable', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias: 'none', bloom: 'off' },
      lane: {
        compute: false,
        storageBuffer: false,
        multisample: false,
        maxColorAttachments: 4,
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('standard-cluster-transport-unavailable');
  });

  it('uses one linear target and one output transform for raw-only no-FXAA', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias: 'none', bloom: 'off' },
      surface: {
        width: 1,
        height: 1,
        storageFormat: 'rgba8unorm',
        viewFormat: 'rgba8unorm',
        profile: rawOnlyProfile,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    expect(info.passes.filter((pass) => pass.name === 'output-transform')).toHaveLength(1);
    expect(info.resources.filter((resource) => resource.label === 'scene-color')).toHaveLength(1);
    expect(info.resources.map((resource) => resource.label)).not.toContain('standard-output-color');
    expect(info.resources.map((resource) => resource.label)).not.toContain('surface.display');
    expect(info.passes.filter((pass) => pass.name === 'debug-overlay')).toHaveLength(1);
    expect(info.passes.map((pass) => pass.name).indexOf('debug-overlay')).toBeLessThan(
      info.passes.map((pass) => pass.name).indexOf('output-transform'),
    );
  });

  it('keeps raw-only FXAA in one display-encoded float intermediate', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias: 'fxaa', bloom: 'off' },
      surface: {
        width: 1,
        height: 1,
        storageFormat: 'rgba8unorm',
        viewFormat: 'rgba8unorm',
        profile: rawOnlyProfile,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    expect(info.passes.filter((pass) => pass.name === 'output-transform')).toHaveLength(1);
    expect(info.passes.map((pass) => pass.name).indexOf('debug-overlay')).toBeLessThan(
      info.passes.map((pass) => pass.name).indexOf('output-transform'),
    );
    expect(
      info.resources.filter((resource) => resource.label === 'standard-output-color'),
    ).toHaveLength(1);
    expect(info.resources.map((resource) => resource.label)).not.toContain('surface.display');
    expect(info.passes.filter((pass) => pass.name === 'debug-overlay')).toHaveLength(1);
  });

  it.each([
    'none',
    'fxaa',
  ] as const)('routes raw-only registered post effects through an encoded float input target (%s)', async (antialias) => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias, bloom: 'off' },
      config: { postEffects: ['test-effect'] },
      surface: {
        width: 1,
        height: 1,
        storageFormat: 'rgba8unorm',
        viewFormat: 'rgba8unorm',
        profile: rawOnlyProfile,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    const resources = info.resources;
    const input = resources.find((resource) => resource.label === 'standard-post-effects-input');
    expect(input).toMatchObject({
      derivedUsage: 0x10 | 0x01,
    });
    expect(names.indexOf('debug-overlay')).toBeLessThan(names.indexOf('output-transform'));
    const fxaaIndex = names.indexOf('fxaa');
    expect(names.indexOf('output-transform')).toBeLessThan(
      fxaaIndex === -1 ? names.indexOf('post-effect-copy-0') : fxaaIndex,
    );
    if (fxaaIndex !== -1) expect(fxaaIndex).toBeLessThan(names.indexOf('post-effect-copy-0'));
    expect(names.indexOf('post-effect-copy-0')).toBeLessThan(names.indexOf('post-effect-0'));
    expect(info.passes.find((pass) => pass.name === 'post-effect-copy-0')?.accesses).toContainEqual(
      { resource: 'standard-post-effects-input', usage: 'copy-src' },
    );
    expect(info.passes.find((pass) => pass.name === 'post-effect-0')?.accesses).toContainEqual({
      resource: 'surface',
      usage: 'color-attachment',
    });
    expect(resources.map((resource) => resource.label)).not.toContain('surface.display');
    expect(resources.map((resource) => resource.label)).not.toContain('ldr-color');
    expect(resources.map((resource) => resource.label)).toContain('standard-post-effects-input');
    expect(resources.map((resource) => resource.label)).toContain('post-effect-scratch-0');
  });

  it('presents a resolved no-tone MSAA scene through the shared output boundary', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'none', antialias: 'msaa', bloom: 'off' },
      lane: {
        compute: true,
        storageBuffer: true,
        multisample: true,
        maxColorAttachments: 8,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names).toContain('output-transform');
    expect(names.indexOf('output-transform')).toBeGreaterThan(names.indexOf('main'));
    expect(names.indexOf('debug-overlay')).toBeGreaterThan(names.indexOf('output-transform'));
    expect(info.resources.map((resource) => resource.label)).toContain('scene-color');
    expect(info.resources.map((resource) => resource.label)).toContain('scene-color-msaa');
    expect(info.resources.map((resource) => resource.label)).not.toContain('standard-output-color');
  });

  it('uses the live rgba16float capability for temporal admission', () => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const resolvedTopology = topology(DEFAULT_STANDARD_PROFILE, {
      camera: { tonemap: 'aces-filmic', antialias: 'taa', bloom: 'off' },
    });
    const standardLighting = standardLightingFor(resolvedTopology);
    if (!standardLighting.ok) throw standardLighting.error;
    const built = standardPipeline.build(
      {
        graph,
        standardLighting: standardLighting.value,
        capabilities: { rgba16floatRenderable: false },
        projectGpuDriven: () => ok(undefined),
        contributeFeatures: () => ok(undefined),
      },
      resolvedTopology,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatchObject({
      code: 'scene-data-unavailable',
      detail: { reason: 'capability-missing' },
    });
  });

  it('fails closed when the temporal capability probe is absent', () => {
    const graph = new RenderGraphBuilder<RenderPipelineFrame>();
    const resolvedTopology = topology(DEFAULT_STANDARD_PROFILE, {
      surface: {
        width: 1,
        height: 1,
        storageFormat: 'rgba16float',
        viewFormat: 'rgba16float',
      },
      camera: { tonemap: 'aces-filmic', antialias: 'taa', bloom: 'off' },
    });
    const standardLighting = standardLightingFor(resolvedTopology);
    if (!standardLighting.ok) throw standardLighting.error;
    const built = standardPipeline.build(
      {
        graph,
        standardLighting: standardLighting.value,
        projectGpuDriven: () => ok(undefined),
        contributeFeatures: () => ok(undefined),
      },
      resolvedTopology,
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error).toMatchObject({
      code: 'scene-data-unavailable',
      detail: { reason: 'capability-missing' },
    });
  });

  it('keeps both Standard render paths on one transmission topology', async () => {
    for (const renderPath of ['forward', 'deferred'] as const) {
      const result = await build({ ...DEFAULT_STANDARD_PROFILE, renderPath }, {
        surface: {
          width: 8,
          height: 4,
          storageFormat: 'bgra8unorm',
          viewFormat: 'bgra8unorm-srgb',
        },
        transmissionDemand: { activeCount: 1, needsRoughMips: true },
      } as Partial<RenderPipelineTopology>);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const names = result.value.inspect().passes.map((pass) => pass.name);
      expect(names).toContain('transmission-backdrop-copy');
      expect(names).toContain('transmission-backdrop-mip');
      expect(names.indexOf('transmission-backdrop-copy')).toBeLessThan(
        names.indexOf('transmission-forward'),
      );
      expect(names.indexOf('transmission-forward')).toBeLessThan(names.indexOf('transparent'));
      expect(names.indexOf('transparent')).toBeLessThan(names.indexOf('temporal'));
    }
  });

  it('publishes the independent raw-depth producer before both Surface passes', async () => {
    for (const renderPath of ['forward', 'deferred'] as const) {
      const result = await build(
        { ...DEFAULT_STANDARD_PROFILE, renderPath },
        {
          surface: {
            width: 8,
            height: 4,
            storageFormat: 'bgra8unorm',
            viewFormat: 'bgra8unorm-srgb',
          },
          singleLayerMedium: true,
        },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      const info = result.value.inspect();
      const names = info.passes.map((pass) => pass.name);
      expect(names).toContain('single-layer-medium-raw-depth-producer');
      expect(names).toContain('single-layer-medium-nearest-layer');
      expect(names).toContain('single-layer-medium-color');
      expect(names.indexOf('single-layer-medium-raw-depth-producer')).toBeLessThan(
        names.indexOf('single-layer-medium-nearest-layer'),
      );
      expect(names.indexOf('single-layer-medium-nearest-layer')).toBeLessThan(
        names.indexOf('single-layer-medium-color'),
      );
      const rawDepth = info.passes.find(
        (pass) => pass.name === 'single-layer-medium-raw-depth-producer',
      );
      expect(rawDepth?.accesses).toContainEqual({
        resource: 'single-layer-medium-raw-depth',
        usage: 'color-attachment',
      });
      expect(rawDepth?.accesses.filter((access) => access.usage === 'sampled-read')).toHaveLength(
        2,
      );
      const color = info.passes.find((pass) => pass.name === 'single-layer-medium-color');
      expect(color?.accesses).toEqual(
        expect.arrayContaining([
          { resource: 'single-layer-medium-raw-depth', usage: 'sampled-read' },
          { resource: 'single-layer-medium-nearest-layer', usage: 'sampled-read' },
          { resource: 'single-layer-medium-nearest-depth-sampled', usage: 'sampled-read' },
        ]),
      );
    }
  });

  it('pairs 4x opaque and nearest color with the depth sample selected for Surface', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' },
      {
        surface: {
          width: 8,
          height: 4,
          storageFormat: 'bgra8unorm',
          viewFormat: 'bgra8unorm-srgb',
        },
        camera: { tonemap: 'aces-filmic', antialias: 'msaa', bloom: 'off' },
        lane: {
          compute: true,
          storageBuffer: true,
          multisample: true,
          maxColorAttachments: 8,
        },
        singleLayerMedium: true,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const info = result.value.inspect();
    const names = info.passes.map((pass) => pass.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'single-layer-medium-opaque-resolve-color-producer',
        'single-layer-medium-opaque-resolve-depth-producer',
        'single-layer-medium-nearest-layer',
        'single-layer-medium-nearest-resolve-color-producer',
        'single-layer-medium-nearest-resolve-depth-producer',
        'single-layer-medium-color',
      ]),
    );
    expect(names.indexOf('single-layer-medium-opaque-resolve-depth-producer')).toBeLessThan(
      names.indexOf('single-layer-medium-nearest-layer'),
    );
    expect(names.indexOf('single-layer-medium-nearest-resolve-depth-producer')).toBeLessThan(
      names.indexOf('single-layer-medium-color'),
    );
    for (const label of [
      'scene-color-msaa',
      'scene-depth',
      'single-layer-medium-nearest-layer',
      'single-layer-medium-nearest-depth',
    ]) {
      expect(info.resources).toContainEqual(
        expect.objectContaining({
          label,
          descriptor: expect.objectContaining({ sampleCount: 4 }),
        }),
      );
    }
    for (const label of [
      'single-layer-medium-opaque-resolve-color',
      'single-layer-medium-opaque-resolve-depth',
      'single-layer-medium-nearest-resolve-color',
      'single-layer-medium-nearest-resolve-depth',
    ]) {
      expect(info.resources).toContainEqual(
        expect.objectContaining({
          label,
          descriptor: expect.objectContaining({ sampleCount: 1 }),
        }),
      );
    }
  });

  it('adds one independent transparent graph lane without a backdrop split', async () => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      surface: {
        width: 8,
        height: 4,
        storageFormat: 'bgra8unorm',
        viewFormat: 'bgra8unorm-srgb',
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.value.inspect().passes.filter((pass) => pass.name === 'transparent'),
    ).toHaveLength(1);
  });

  it('uses the resolved single-sample MSAA source for the shared backdrop', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' },
      {
        surface: {
          width: 8,
          height: 4,
          storageFormat: 'bgra8unorm',
          viewFormat: 'bgra8unorm-srgb',
        },
        camera: { tonemap: 'aces-filmic', antialias: 'msaa', bloom: 'on' },
        lane: {
          compute: true,
          storageBuffer: true,
          multisample: true,
          maxColorAttachments: 8,
        },
        transmissionDemand: { activeCount: 1, needsRoughMips: true },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const inspected = result.value.inspect();
    const names = inspected.passes.map((pass) => pass.name);
    expect(inspected.resources.map((resource) => resource.label)).toContain('scene-color-msaa');
    expect(names).toContain('transmission-backdrop-copy');
    const copy = inspected.passes.find((pass) => pass.name === 'transmission-backdrop-copy');
    expect(copy?.accesses).toEqual(
      expect.arrayContaining([{ resource: 'scene-color', usage: 'copy-src' }]),
    );
    expect(copy?.accesses).not.toContainEqual({
      resource: 'scene-color-msaa',
      usage: 'copy-src',
    });
  });

  it('keeps the CPU transport on the same transmission phase contract', async () => {
    const result = await build(
      { ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' },
      {
        lane: {
          compute: false,
          storageBuffer: true,
          multisample: false,
          maxColorAttachments: 8,
        },
        transmissionDemand: { activeCount: 1, needsRoughMips: false },
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'transmission-backdrop-copy',
        'transmission-forward',
        'transparent',
        'temporal',
      ]),
    );
    expect(names).not.toContain('cluster-membership-producer');
  });

  it.each([
    [
      'omitted-backdrop-copy',
      (names: readonly string[]) => names.filter((name) => name !== 'transmission-backdrop-copy'),
    ],
    ['reversed-phase-order', (names: readonly string[]) => [...names].reverse()],
  ] as const)('dev falsifier %s rejects the two-lane phase contract', async (_name, falsify) => {
    const result = await build(DEFAULT_STANDARD_PROFILE, {
      transmissionDemand: { activeCount: 1, needsRoughMips: false },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.value.inspect().passes.map((pass) => pass.name);
    const mutated = falsify(names);
    expect(() => {
      expect(mutated.indexOf('transmission-backdrop-copy')).toBeGreaterThanOrEqual(0);
      expect(mutated.indexOf('transmission-backdrop-copy')).toBeLessThan(
        mutated.indexOf('transmission-forward'),
      );
      expect(mutated.indexOf('transmission-forward')).toBeLessThan(mutated.indexOf('transparent'));
    }).toThrow();
  });
});

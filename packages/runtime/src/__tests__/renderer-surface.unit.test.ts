// @forgeax/engine-runtime — surface retry unit tests
//
// Covers:
//   w5 — F2 surface retry: reconfigure + retry once, frame continues (AC-03)
//   w6 — F2 surface consecutive failure -> internal-fault (AC-04)
//
// Tests drive recordFrame() directly with mock internals. All mock objects
// are typed through `any` to avoid constructing full RhiDevice / PipelineState /
// AssetRegistry / GpuResourceStore objects (each is ~50+ fields with branded
// opaque types). The test surface is the recordFrame function — verify that
// getCurrentTexture failure triggers reconfigure+retry and that consecutive
// failures escalate to health internal-fault.

import { RhiError } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { recordFrame } from '../record';
import { HealthListenerRegistry } from '../renderer';

// biome-ignore lint/suspicious/noExplicitAny: mock objects are intentionally opaque in test code
type MockObj = Record<string, any>;

function makePipelineState(): MockObj {
  return {
    meshes: new Map(),
    format: 'bgra8unorm',
    colorAttachmentFormat: 'bgra8unorm-srgb',
    standardPipeline: { __brand: 'RP' },
    standardPipelineHdr: { __brand: 'RP' },
    standardPipelineMsaa: { __brand: 'RP' },
    standardPipelineHdrMsaa: { __brand: 'RP' },
    unlitPipeline: { __brand: 'RP' },
    unlitPipelineHdr: { __brand: 'RP' },
    unlitPipelineMsaa: { __brand: 'RP' },
    unlitPipelineHdrMsaa: { __brand: 'RP' },
    spritePipeline: { __brand: 'RP' },
    spritePipelineHdr: { __brand: 'RP' },
    spritePipelineMsaa: { __brand: 'RP' },
    spritePipelineHdrMsaa: { __brand: 'RP' },
    perPassResources: { configured: true },
    cameraUniformBuffer: { __brand: 'Buf' },
    lightsUniformBuffer: { __brand: 'Buf' },
    skyIBLBuffer: { __brand: 'Buf' },
    meshStorageBuffer: { buffer: { __brand: 'Buf' }, writeBuffer: () => ({ ok: true }) },
    materialUBOBuffer: { __brand: 'Buf' },
    shadowParamsBuffer: { __brand: 'Buf' },
    defaultWhiteTextureView: { __brand: 'TV' },
    defaultNormalTextureView: { __brand: 'TV' },
    fallbackTextureView: { __brand: 'TV' },
    materialBindGroupLayout: { __brand: 'BGL' },
    meshBindGroupLayout: { __brand: 'BGL' },
    viewBindGroupLayout: { __brand: 'BGL' },
    instancesBindGroupLayout: { __brand: 'BGL' },
    shadowViewBindGroupLayout: { __brand: 'BGL' },
    standardBindGroup: { __brand: 'BG' },
    skyboxRenderPipeline: { __brand: 'RP' },
    skyboxBindGroupLayout: { __brand: 'BGL' },
    depthStencilState: { format: 'depth24plus-stencil8' },
    _skinBgCacheStats: { total: 0, capacity: 0 },
    device: { limits: { maxStorageBuffersPerShaderStage: 0 } },
    formatBgra8Unorm: 'bgra8unorm',
    shadowViewBindGroup: { __brand: 'BG' },
    shadowSampler: { __brand: 'S' },
    shadowViewTexture: { __brand: 'TV' },
  };
}

function makeMockDevice(_ps: MockObj): MockObj {
  return {
    __brand: 'Dev',
    lost: new Promise(() => {}),
    features: new Set<string>(),
    // biome-ignore lint/suspicious/noExplicitAny: test mock
    limits: { maxStorageBuffersPerShaderStage: 0 } as any,
    queue: { submit: () => undefined, writeBuffer: () => ({ ok: true }) },
    createBuffer: () => ({ ok: true, value: { __brand: 'Buf' } }),
    createTexture: () => ({ ok: true, value: { __brand: 'Tex' } }),
    createBindGroupLayout: () => ({ ok: true, value: { __brand: 'BGL' } }),
    createBindGroup: () => ({ ok: true, value: { __brand: 'BG' } }),
    createPipelineLayout: () => ({ ok: true, value: { __brand: 'PL' } }),
    createRenderPipeline: () => ({ ok: true, value: { __brand: 'RP' } }),
    createSampler: () => ({ ok: true, value: { __brand: 'S' } }),
    createShaderModule: () => ({ ok: true, value: { __brand: 'SM' } }),
    createTextureView: () => ({ ok: true, value: { __brand: 'TV' } }),
    createCommandEncoder: () => ({
      ok: true,
      value: {
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
          setViewport: () => undefined,
          setScissorRect: () => undefined,
          setBlendConstant: () => undefined,
          setStencilReference: () => undefined,
        }),
        finish: () => ({ __brand: 'CB' }),
      },
    }),
  };
}

function makeSurfaceCtx(
  cfgCalls: { n: number },
  ctxCalls: { n: number },
  failCount: number,
): MockObj {
  return {
    configure: () => {
      cfgCalls.n++;
      return { ok: true };
    },
    unconfigure: () => undefined,
    getCurrentTexture: () => {
      ctxCalls.n++;
      if (ctxCalls.n <= failCount) {
        return {
          ok: false,
          error: new RhiError({ code: 'webgpu-runtime-error', expected: 'failed', hint: 'retry' }),
        };
      }
      return { ok: true, value: { __brand: 'Tex' } };
    },
  };
}

function makeCameras(): MockObj[] {
  return [
    {
      fov: 1,
      aspect: 1,
      near: 0.1,
      far: 100,
      posX: 0,
      posY: 0,
      posZ: 10,
      quatX: 0,
      quatY: 0,
      quatZ: 0,
      quatW: 1,
      viewMatrix: new Float32Array(16),
      projMatrix: new Float32Array(16),
      clearR: 0,
      clearG: 0,
      clearB: 0,
      clearA: 1,
    },
  ];
}

function makeLights(): MockObj {
  return {
    directional: undefined,
    directionalCount: 0,
    point: [],
    spot: [],
    lightViewProj: undefined,
    splitPlanes: undefined,
    cascadeCount: undefined,
    cascadeBlendWidth: undefined,
    cascadeBlend: undefined,
    csmShadowMapView: undefined,
    csmShadowAtlasSlot: undefined,
    csmShadowSplitCount: undefined,
    csmShadowCascadeCount: undefined,
    csmActive: false,
    shadowMapSize: 0,
    depthBias: 0,
    normalBias: 0,
    pcfKernelSize: 0,
    pointShadow: [],
  };
}

function makeFrameState(): MockObj {
  return {
    frameNumber: 1,
    perFrameGraph: null,
    instanceBuffers: new Map(),
    warnedZeroLightStandard: false,
    warnedMultiLightDirectional: false,
    warnedMultiLightPoint: false,
    warnedMultiLightSpot: false,
    warnedSkyboxTonemapNone: false,
    warnedMissingBaseColorTextureHandles: new Set<number>(),
    warnedNineSliceScaleEntities: new Set<number>(),
    viewBindGroupCache: new Map(),
    meshBindGroupCache: new Map(),
    materialBgCache: new Map(),
    instancesBgCache: new Map(),
    handleToId: new WeakMap<object, number>(),
    nextHandleId: 0,
    installedPipelineHandle: 0,
    activePipeline: { buildGraph: () => null, execute: () => undefined },
    installedPipelineConfig: undefined,
    isHdrpActive: false,
    hdrpOncePerFrameFired: new Set(),
    pointShadowAtlas: null,
    pointShadowSnapshots: [],
    lastFoldBucketCount: 0,
  };
}

function makeDispatchCounts(): MockObj {
  return { mainForward: 0, shadowCaster: 0, transparent: 0, skybox: 0, postProcess: 0, unlit: 0 };
}

function makeBindGroupCounts(): MockObj {
  return { createBindGroup: 0, keys: [] };
}

function callRecordFrame(
  // biome-ignore lint/suspicious/noExplicitAny: mock internals
  internals: any,
  // biome-ignore lint/suspicious/noExplicitAny: mock cameras
  cameras: any,
  // biome-ignore lint/suspicious/noExplicitAny: mock lights
  lights: any,
  // biome-ignore lint/suspicious/noExplicitAny: mock frameState
  frameState: any,
  // biome-ignore lint/suspicious/noExplicitAny: mock dispatchCounts
  dispatchCounts: any,
  // biome-ignore lint/suspicious/noExplicitAny: mock bindGroupCounts
  bindGroupCounts: any,
): void {
  recordFrame(
    // biome-ignore lint/suspicious/noExplicitAny: mock internals for test
    internals as any,
    // biome-ignore lint/suspicious/noExplicitAny: mock world
    null as any,
    // biome-ignore lint/suspicious/noExplicitAny: mock cameras
    cameras as any,
    // biome-ignore lint/suspicious/noExplicitAny: mock lights
    lights as any,
    // biome-ignore lint/suspicious/noExplicitAny: mock renderables
    [] as any,
    // biome-ignore lint/suspicious/noExplicitAny: mock transparent dispatch
    [] as any,
    // biome-ignore lint/suspicious/noExplicitAny: mock frameState
    frameState as any,
    // biome-ignore lint/suspicious/noExplicitAny: mock dispatchCounts
    dispatchCounts as any,
    // biome-ignore lint/suspicious/noExplicitAny: mock bindGroupCounts
    bindGroupCounts as any,
    undefined,
    0,
    undefined,
    0,
    new Map<string, Uint8Array>(),
  );
}

// ── w5: surface retry — reconfigure + retry once (AC-03) ─────────────────────

describe('Surface retry (w5)', () => {
  it('w5: getCurrentTexture fail-once -> reconfigure -> retry succeeds', () => {
    const cfgCalls = { n: 0 };
    const ctxCalls = { n: 0 };
    const ps = makePipelineState();
    const reg = new HealthListenerRegistry();
    const mockCtx = makeSurfaceCtx(cfgCalls, ctxCalls, 1);
    const dev = makeMockDevice(ps);

    // biome-ignore lint/suspicious/noExplicitAny: test internals
    const internals: any = {
      canvas: { width: 800, height: 600 },
      device: dev,
      context: mockCtx,
      getPipelineState: () => ps,
      assets: { register: () => ({ ok: true }), instantiate: () => ({ ok: true }) },
      gpuStore: {
        destroyAll: () => undefined,
        ensureResident: () => ({ ok: true }),
        getMeshGpuHandles: () => ({
          ok: true,
          value: {
            indexBuffer: { __brand: 'Buf' },
            vertexBuffer: { __brand: 'Buf' },
            indexFormat: 'uint32',
            indexCount: 0,
            vertexCount: 0,
          },
        }),
        getTextureView: () => ({ ok: true, value: { __brand: 'TV' } }),
        resolveHandleId: () => 0,
      },
      errorRegistry: { add: () => () => {}, fire: (_e: unknown) => {}, clear: () => {} },
      getMaterialShaderPipeline: undefined,
      getParamSchema: undefined,
      getMaterialBindGroupLayout: undefined,
      metrics: { increment: () => undefined, counter: () => 0 },
      growMeshSsbo: undefined,
      meshSsboState: undefined,
      buildPostProcessPipeline: undefined,
      healthRegistry: reg,
    };

    callRecordFrame(
      internals,
      makeCameras(),
      makeLights(),
      makeFrameState(),
      makeDispatchCounts(),
      makeBindGroupCounts(),
    );

    // AC-03: getCurrentTexture called twice (fail + retry)
    expect(ctxCalls.n).toBe(2);
    // AC-03: context configured (retry reconfigure)
    expect(cfgCalls.n).toBe(1);
  });

  it('w5(b): normal hot path — zero reconfigure calls (AC-05)', () => {
    const cfgCalls = { n: 0 };
    const ctxCalls = { n: 0 };
    const ps = makePipelineState();
    const mockCtx = makeSurfaceCtx(cfgCalls, ctxCalls, 0);
    const dev = makeMockDevice(ps);

    // biome-ignore lint/suspicious/noExplicitAny: test internals
    const internals: any = {
      canvas: { width: 800, height: 600 },
      device: dev,
      context: mockCtx,
      getPipelineState: () => ps,
      assets: { register: () => ({ ok: true }), instantiate: () => ({ ok: true }) },
      gpuStore: {
        destroyAll: () => undefined,
        ensureResident: () => ({ ok: true }),
        getMeshGpuHandles: () => ({
          ok: true,
          value: {
            indexBuffer: { __brand: 'Buf' },
            vertexBuffer: { __brand: 'Buf' },
            indexFormat: 'uint32',
            indexCount: 0,
            vertexCount: 0,
          },
        }),
        getTextureView: () => ({ ok: true, value: { __brand: 'TV' } }),
        resolveHandleId: () => 0,
      },
      errorRegistry: { add: () => () => {}, fire: (_e: unknown) => {}, clear: () => {} },
      getMaterialShaderPipeline: undefined,
      getParamSchema: undefined,
      getMaterialBindGroupLayout: undefined,
      metrics: { increment: () => undefined, counter: () => 0 },
      growMeshSsbo: undefined,
      meshSsboState: undefined,
      buildPostProcessPipeline: undefined,
      healthRegistry: new HealthListenerRegistry(),
    };

    callRecordFrame(
      internals,
      makeCameras(),
      makeLights(),
      makeFrameState(),
      makeDispatchCounts(),
      makeBindGroupCounts(),
    );

    // AC-05: normal hot path — getCurrentTexture once, reconfigure zero
    expect(ctxCalls.n).toBe(1);
    expect(cfgCalls.n).toBe(0);
  });
});

// ── w6: consecutive surface failure -> internal-fault (AC-04) ────────────────

describe('Surface consecutive failure (w6)', () => {
  it('w6: both attempts fail -> health().reason is internal-fault with surface detail', () => {
    const cfgCalls = { n: 0 };
    const ctxCalls = { n: 0 };
    const ps = makePipelineState();
    const reg = new HealthListenerRegistry();
    const mockCtx = makeSurfaceCtx(cfgCalls, ctxCalls, 999);
    const dev = makeMockDevice(ps);

    // biome-ignore lint/suspicious/noExplicitAny: test internals
    const internals: any = {
      canvas: { width: 800, height: 600 },
      device: dev,
      context: mockCtx,
      getPipelineState: () => ps,
      assets: { register: () => ({ ok: true }), instantiate: () => ({ ok: true }) },
      gpuStore: {
        destroyAll: () => undefined,
        ensureResident: () => ({ ok: true }),
        getMeshGpuHandles: () => ({
          ok: true,
          value: {
            indexBuffer: { __brand: 'Buf' },
            vertexBuffer: { __brand: 'Buf' },
            indexFormat: 'uint32',
            indexCount: 0,
            vertexCount: 0,
          },
        }),
        getTextureView: () => ({ ok: true, value: { __brand: 'TV' } }),
        resolveHandleId: () => 0,
      },
      errorRegistry: { add: () => () => {}, fire: (_e: unknown) => {}, clear: () => {} },
      getMaterialShaderPipeline: undefined,
      getParamSchema: undefined,
      getMaterialBindGroupLayout: undefined,
      metrics: { increment: () => undefined, counter: () => 0 },
      growMeshSsbo: undefined,
      meshSsboState: undefined,
      buildPostProcessPipeline: undefined,
      healthRegistry: reg,
    };

    // Baseline: alive
    expect(reg.getLastSnapshot().reason).toBe('alive');

    callRecordFrame(
      internals,
      makeCameras(),
      makeLights(),
      makeFrameState(),
      makeDispatchCounts(),
      makeBindGroupCounts(),
    );

    // AC-04: health reason is internal-fault
    const snap = reg.getLastSnapshot();
    expect(snap.reason).toBe('internal-fault');
    if (snap.reason === 'internal-fault') {
      expect(snap.detail.message).toMatch(/surface/i);
    }
  });
});

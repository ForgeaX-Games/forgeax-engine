import { describe, expect, it, vi } from 'vitest';

import {
  ensurePerFrameGraph,
  resolveShadowMapSize,
  writebackGraphViews,
} from './record/frame-targets';

describe('frame targets shadow removal', () => {
  it('clears every shadow slot when the final caster disappears', () => {
    const graph = {
      getColorTargetTexture: (name: string) =>
        name === 'shadowDepth' ? { id: 'shadow' } : undefined,
      getColorTargetView: () => undefined,
    };
    const resources = {
      shadowTexture: { id: 'shadow' },
      shadowMapSize: 2048,
      shadowCascadeCount: 4,
      shadowLightSpaceMatrix: new Float32Array(16).fill(1),
      shadowCsmLightViewProj: new Float32Array(64).fill(1),
    };

    writebackGraphViews(
      { perFrameGraph: graph } as never,
      { perPassResources: resources } as never,
      { cascadeCount: undefined } as never,
      null,
      undefined,
      800,
      600,
    );

    expect(resources.shadowTexture).toBeNull();
    expect(resources.shadowMapSize).toBe(0);
    expect(resources.shadowCascadeCount).toBe(0);
    expect(resources.shadowLightSpaceMatrix).toBeNull();
    expect(resources.shadowCsmLightViewProj).toBeNull();
  });

  it('rebuilds once after a 1-to-0 shadow transition', () => {
    const rebuiltGraph = {
      getColorTargetTexture: () => undefined,
      getColorTargetView: () => undefined,
      setSwapChainSize: () => false,
    };
    const buildGraph = vi.fn(() => rebuiltGraph);
    const resources = {
      shadowTexture: { id: 'shadow' },
      shadowMapSize: 2048,
      shadowCascadeCount: 4,
      shadowLightSpaceMatrix: new Float32Array(16).fill(1),
      shadowCsmLightViewProj: new Float32Array(64).fill(1),
    };
    const frameState = {
      perFrameGraph: {
        getColorTargetTexture: () => undefined,
        getColorTargetView: () => undefined,
        setSwapChainSize: () => false,
        retire: vi.fn(),
        reclaimRetiredTransients: () => Promise.resolve(),
      },
      retiredPerFrameGraphs: new Set(),
      activePipeline: { buildGraph },
      installedPipelineConfig: {},
    };
    const noShadowLights = { shadowMapSize: undefined, cascadeCount: undefined };
    const internals = {
      device: { caps: { backendKind: 'webgpu' } },
      errorRegistry: { fire: vi.fn() },
    };

    ensurePerFrameGraph(
      internals as never,
      frameState as never,
      { perPassResources: resources } as never,
      { tonemap: 'none' } as never,
      noShadowLights as never,
      undefined,
      0,
      undefined,
      800,
      600,
    );
    writebackGraphViews(
      frameState as never,
      { perPassResources: resources } as never,
      noShadowLights as never,
      null,
      undefined,
      800,
      600,
    );
    ensurePerFrameGraph(
      internals as never,
      frameState as never,
      { perPassResources: resources } as never,
      { tonemap: 'none' } as never,
      noShadowLights as never,
      undefined,
      0,
      undefined,
      800,
      600,
    );

    expect(buildGraph).toHaveBeenCalledTimes(1);
  });

  it('fits a cascaded shadow atlas within the device texture limit', () => {
    const internals = {
      device: { limits: { maxTextureDimension2D: 2048 } },
    };
    const lights = { shadowMapSize: 2048, cascadeCount: 4 };

    expect(resolveShadowMapSize(internals as never, lights as never)).toBe(1024);
    expect(resolveShadowMapSize(internals as never, { ...lights, cascadeCount: 1 } as never)).toBe(
      2048,
    );
  });

  it('reserves the WebGL2 depth-texture ceiling below the generic texture limit', () => {
    const internals = {
      device: {
        caps: { backendKind: 'wgpu-webgl2' },
        limits: { maxTextureDimension2D: 2048 },
      },
    };
    const lights = { shadowMapSize: 2048, cascadeCount: 1 };

    expect(resolveShadowMapSize(internals as never, lights as never)).toBe(1024);
  });
});

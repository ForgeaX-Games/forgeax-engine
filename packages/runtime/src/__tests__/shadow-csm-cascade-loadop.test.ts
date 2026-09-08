// shadow-csm-cascade-loadop.test.ts - typed shadow per-cascade depth clear
// @perf-budget-skip - the two truth-table cases intentionally drive the full renderer call site.
// M1: per-cascade depth loadOp truth table, asserted against the REAL call site.
//
// The invariant is owned by the typed shadow graph's cascade recording path:
//   buildBeginRenderPassDescriptor(..., 'shadow-caster',
//     { depthLoadOp: cascadeIndex === 0 ? 'clear' : 'load' })
//
// This test does NOT re-declare the decision expression and feed it to the
// pure builder (that would be tautological — the bug could regress verbatim
// while the suite stays green). Instead it drives the whole pipeline through
// createRenderer + renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 }): the URP cascade loop calls
// one typed shadow pass per cascade, whose execute closure invokes the real
// encodeDirectionalShadowPass(c, pass, cascadeIndex, viewport). A mock GPU device
// captures every descriptor handed to beginRenderPass on the dedicated
// 'render-system-shadow' command encoder, so the asserted truth table is the
// engine's decision at the real call site — flip the ternary to a constant and
// these assertions fail.

import type { World as WorldType } from '@forgeax/engine-ecs';
import type { Renderer as RendererType } from '@forgeax/engine-render';
import type { Handle } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ENGINE = '../createRenderer';

interface ShadowPassDescriptor {
  depthLoadOp: string;
  depthStoreOp: string;
  hasDepthClearValue: boolean;
  depthClearValue: number | undefined;
}

interface CaptureLog {
  // Descriptors captured from beginRenderPass on the 'render-system-shadow'
  // encoder, in record order (cascade 0, 1, ... N-1).
  shadowPassDescriptors: ShadowPassDescriptor[];
}

function makeMockGL2(): unknown {
  return {
    __mockTag: 'webgl2',
    getExtension: () => null,
    getParameter: () => 1,
    isContextLost: () => false,
  };
}

function makeMockCanvas(): HTMLCanvasElement {
  const canvas = {
    width: 800,
    height: 600,
    getContext(kind: string): unknown {
      if (kind === 'webgl2') return makeMockGL2();
      if (kind === 'webgpu') {
        return {
          __mockTag: 'webgpu-canvas-context',
          configure: () => undefined,
          unconfigure: () => undefined,
          getCurrentTexture: () => ({ createView: () => ({}) }),
        };
      }
      return null;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
}

function captureShadowDescriptor(
  log: CaptureLog,
  descriptor: { depthStencilAttachment?: Record<string, unknown> } | undefined,
): void {
  const ds = descriptor?.depthStencilAttachment;
  if (ds === undefined) return;
  log.shadowPassDescriptors.push({
    depthLoadOp: ds.depthLoadOp as string,
    depthStoreOp: ds.depthStoreOp as string,
    hasDepthClearValue: Object.hasOwn(ds, 'depthClearValue'),
    depthClearValue: ds.depthClearValue as number | undefined,
  });
}

function makeRenderPassEncoder(): Record<string, unknown> {
  return {
    setPipeline: () => undefined,
    setVertexBuffer: () => undefined,
    setIndexBuffer: () => undefined,
    setBindGroup: () => undefined,
    setViewport: () => undefined,
    draw: () => undefined,
    drawIndexed: () => undefined,
    setStencilReference: () => undefined,
    end: () => undefined,
  };
}

function makeMockGPUDevice(log: CaptureLog): unknown {
  const lost = new Promise<unknown>(() => undefined);
  return {
    __mockTag: 'gpu-device',
    lost,
    features: new Set(),
    limits: {},
    queue: {
      submit: () => undefined,
      writeBuffer: () => undefined,
      writeTexture: () => undefined,
    },
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createBuffer: () => ({
      getMappedRange: () => new ArrayBuffer(64),
      unmap: () => undefined,
    }),
    createCommandEncoder: () => {
      return {
        beginRenderPass: (rpDesc?: {
          label?: string;
          depthStencilAttachment?: Record<string, unknown>;
        }) => {
          if (rpDesc?.label?.startsWith('shadowCascade') === true) {
            captureShadowDescriptor(log, rpDesc);
          }
          return makeRenderPassEncoder();
        },
        finish: () => ({}),
      };
    },
    createTexture: () => ({ createView: () => ({}) }),
    createSampler: () => ({}),
    destroy: () => undefined,
  };
}

function makeMockGPU(device: unknown): unknown {
  return {
    requestAdapter: async () => ({ requestDevice: async () => device }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
}

const baseNavigator = { userAgent: 'mock-engine-test' } as Partial<Navigator> as Navigator;

function buildManifestDataUrl(): string {
  const materialShaderStub = (identifier: string, composedWgsl = '/* stub */') => ({
    identifier,
    sourcePath: `${identifier}.wgsl`,
    composedWgsl,
    paramSchema: '[]',
    variants: [],
  });
  const manifest = {
    schemaVersion: '1.0.0',
    entries: [
      { hash: 'pbr00000', wgsl: '/* pbr stub - calls f_schlick( */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      {
        hash: 'tonemap0',
        wgsl: '/* tonemap stub - struct TonemapParams { exposure: f32 }; */',
        glsl: '',
        bindings: '',
      },
    ],
    materialShaders: [
      materialShaderStub('forgeax::default-standard-pbr'),
      materialShaderStub('forgeax::default-unlit'),
      materialShaderStub(
        'forgeax::default-shadow-caster',
        '/* reserved shadow caster - @location(0) position */',
      ),
    ],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

async function importEngine(): Promise<{
  createRenderer: (
    canvas: unknown,
    opts?: unknown,
    bundler?: unknown,
  ) => Promise<{
    subscribe: (listener: (event: unknown) => void) => () => void;
    draw: (worlds: unknown, opts: { cameraOwner: number; resourceOwner: number }) => void;
  }>;
}> {
  const engine = (await import(ENGINE)) as {
    createRenderer: (...args: readonly unknown[]) => Promise<unknown>;
  };
  return {
    createRenderer: async (...args: readonly unknown[]) => {
      const result = (await engine.createRenderer(...args)) as
        | { readonly ok: true; readonly value: unknown }
        | { readonly ok: false; readonly error: unknown };
      if (!result.ok) throw result.error;
      return result.value as {
        subscribe: (listener: (event: unknown) => void) => () => void;
        draw: (worlds: unknown, opts: { cameraOwner: number; resourceOwner: number }) => void;
      };
    },
  };
}

async function importEcs(): Promise<{ World: new () => unknown }> {
  return (await import('@forgeax/engine-ecs')) as never;
}

async function importComponents(): Promise<{
  Transform: unknown;
  MeshFilter: unknown;
  MeshRenderer: unknown;
  Camera: unknown;
  DirectionalLight: unknown;
  HANDLE_CUBE: Handle<'MeshAsset', 'shared'>;
}> {
  return {
    ...(await import('@forgeax/engine-render')),
    ...(await import('@forgeax/engine-scene')),
    ...(await import('@forgeax/engine-assets-runtime')),
  } as never;
}

function identityTransform(): Record<string, number[]> {
  return { pos: [0, 0, 0], quat: [0, 0, 0, 1], scale: [1, 1, 1] };
}

function cameraTransform(): Record<string, number[]> {
  return { ...identityTransform(), pos: [0, 0, 3] };
}

function directionalLight(): Record<string, number | number[]> {
  return {
    direction: [-0.5, -1, -0.3],
    color: [1, 1, 1],
    intensity: 1,
  };
}

async function drawCsmScene(cascadeCount: number): Promise<CaptureLog> {
  const log: CaptureLog = { shadowPassDescriptors: [] };
  const device = makeMockGPUDevice(log);
  vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
  const { createRenderer } = await importEngine();
  const renderer = await createRenderer(
    makeMockCanvas(),
    {},
    { shaderManifestUrl: buildManifestDataUrl() },
  );
  const { World } = await importEcs();
  const C = await importComponents();
  const world = new (
    World as new () => {
      spawn: (...componentDatas: unknown[]) => unknown;
    }
  )();
  world.spawn(
    {
      component: C.Camera,
      data: {
        fov: Math.PI / 4,
        aspect: 16 / 9,
        near: 0.1,
        far: 100,
        projection: 0,
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
      },
    },
    { component: C.Transform, data: cameraTransform() },
  );
  world.spawn({
    component: C.DirectionalLight,
    data: { ...directionalLight(), cascadeCount, mapSize: 1024 },
  });
  world.spawn(
    { component: C.MeshFilter, data: { assetHandle: C.HANDLE_CUBE } },
    { component: C.MeshRenderer, data: {} },
    { component: C.Transform, data: identityTransform() },
  );

  const errors: { code: string }[] = [];
  renderer.subscribe((event) => {
    if (
      typeof event === 'object' &&
      event !== null &&
      'kind' in event &&
      event.kind === 'error' &&
      'error' in event
    ) {
      errors.push(event.error as { code: string });
    }
  });
  if (!(renderer as unknown as RendererType).attach(world as WorldType).ok) {
    throw new Error('World attachment failed');
  }
  (world as WorldType).update().unwrap();
  renderer.draw([world], { cameraOwner: 0, resourceOwner: 0 });
  return log;
}

describe('CSM per-cascade depth loadOp (typed shadow call site)', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { ...baseNavigator });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── AC-03: cascadeCount=4 truth table (drives the real call site) ──────────
  // N=4 cascades share a single shadowDepth atlas. Each cascade pass routes
  // through the typed shadow graph -> beginRenderPass with the per-cascade override.
  // The captured descriptors must read: cascade 0 -> clear + depthClearValue,
  // cascades 1..3 -> load + no depthClearValue.

  it('AC-03: cascadeCount=4 produces clear@0, load@1..3 at the real call site', async () => {
    const log = await drawCsmScene(4);
    expect(log.shadowPassDescriptors).toHaveLength(4);

    // AC-01: cascade 0 clears the whole atlas once.
    const c0 = log.shadowPassDescriptors[0];
    expect(c0?.depthLoadOp).toBe('clear');
    expect(c0?.hasDepthClearValue).toBe(true);
    expect(c0?.depthClearValue).toBe(1);
    expect(c0?.depthStoreOp).toBe('store');

    // AC-02: cascades 1..3 load (preserve prior tiles), never clear.
    for (const i of [1, 2, 3]) {
      const ci = log.shadowPassDescriptors[i];
      expect(ci?.depthLoadOp).toBe('load');
      expect(ci?.hasDepthClearValue).toBe(false);
      expect(ci?.depthStoreOp).toBe('store');
    }
  }, 15_000);

  // ── AC-04: cascadeCount=1 no regression ────────────────────────────────────
  // The single cascade (index 0) must still clear, matching pre-fix behavior.

  it('AC-04: cascadeCount=1 uses clear (no regression)', async () => {
    const log = await drawCsmScene(1);
    expect(log.shadowPassDescriptors).toHaveLength(1);
    const only = log.shadowPassDescriptors[0];
    expect(only?.depthLoadOp).toBe('clear');
    expect(only?.hasDepthClearValue).toBe(true);
    expect(only?.depthClearValue).toBe(1);
    expect(only?.depthStoreOp).toBe('store');
  }, 15_000);
});

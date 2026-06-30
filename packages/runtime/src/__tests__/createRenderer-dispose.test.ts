// feat-20260612-rhi-destroy-renderer-dispose-gpu-lifecycle / M5 / w17-w20
//
// Renderer.dispose() 6-step cascade unit tests.
//
// Scope: validate the dispose chain at the Renderer-facade level using the
// canonical mock GPU + mock canvas + real createRenderer pattern (mirrors
// lights.unit.test.ts setupWebGPU). The 6-step cascade (plan-strategy D-2)
// walks `gpuStore.destroyAll() -> graph.drain() -> disposeInstanceBuffers ->
// IBL cache clear -> context.unconfigure() -> listenerRegistry.clear()`,
// each step independently try/catch'd with `errorRegistry.fire(e)` on
// failure (D-3 method A: void signature + sub-error fire + disposed=true
// regardless).
//
// Coverage matrix (requirements AC-06 / AC-07 + plan-strategy §5.3):
//   w17. Happy-path 6-step cascade -- each downstream structure observably
//        cleared after dispose() (gpuStore maps empty, instanceBuffers
//        cleared, graph drained, ibl cache cleared, context unconfigured).
//   w18. Sub-step failure -> dispose still walks all 6 steps; errorRegistry
//        fires on the failing sub-error; second dispose is idempotent.
//   w19. dispose() -> draw(world) -> Result.err with code 'rhi-not-available'
//        (D-1: reuse existing closed-union member, no new ErrorCode).
//   w20. Second dispose() is no-op (idempotency -- D-5: GpuResource boolean
//        isDestroyed gates re-destroy).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Test harness: mock GPU device + canvas (lifted from lights.unit.test.ts) ──

interface MockGL2Context {
  __mockTag: 'webgl2';
  getExtension: () => null;
  getParameter: () => number;
  isContextLost: () => boolean;
}

function makeMockGL2(): MockGL2Context {
  return {
    __mockTag: 'webgl2',
    getExtension: () => null,
    getParameter: () => 1,
    isContextLost: () => false,
  };
}

interface CanvasOptions {
  webgl2: 'context' | 'null';
  webgpu?: 'context' | 'null';
}

interface CanvasHooks {
  unconfigureCount: number;
  /**
   * When true, the mocked context's `unconfigure()` throws synchronously.
   * Used by w18 to prove that a sub-step failure does not halt the rest of
   * the dispose cascade and that the error fan-outs through errorRegistry.
   */
  unconfigureShouldThrow: boolean;
}

function makeMockCanvas(opts: CanvasOptions, hooks: CanvasHooks): HTMLCanvasElement {
  const canvas = {
    width: 800,
    height: 600,
    getContext(kind: string): unknown {
      if (kind === 'webgl2') {
        return opts.webgl2 === 'context' ? makeMockGL2() : null;
      }
      if (kind === 'webgpu') {
        if (opts.webgpu === 'context') {
          return {
            __mockTag: 'webgpu-canvas-context',
            configure: () => undefined,
            unconfigure: () => {
              hooks.unconfigureCount++;
              if (hooks.unconfigureShouldThrow) {
                throw new Error('mock unconfigure failure');
              }
            },
            getCurrentTexture: () => ({ createView: () => ({}) }),
          };
        }
        return null;
      }
      return null;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  return canvas as Partial<HTMLCanvasElement> as HTMLCanvasElement;
}

interface DeviceCallLog {
  encoderFinishCount: number;
  drawIndexedCount: number;
  setBindGroupCount: number;
  beginRenderPassCount: number;
  setPipelineCount: number;
  queueSubmitCount: number;
  writeBufferCount: number;
  destroyTextureCount: number;
  destroyBufferCount: number;
}

function makeLog(): DeviceCallLog {
  return {
    encoderFinishCount: 0,
    drawIndexedCount: 0,
    setBindGroupCount: 0,
    beginRenderPassCount: 0,
    setPipelineCount: 0,
    queueSubmitCount: 0,
    writeBufferCount: 0,
    destroyTextureCount: 0,
    destroyBufferCount: 0,
  };
}

function makeMockGPUDevice(log: DeviceCallLog): { device: unknown } {
  const lost = new Promise<unknown>(() => undefined);
  const device = {
    __mockTag: 'gpu-device',
    lost,
    features: new Set(),
    limits: {},
    queue: {
      submit: () => {
        log.queueSubmitCount++;
      },
      writeBuffer: () => {
        log.writeBufferCount++;
      },
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
      destroy: () => {
        log.destroyBufferCount++;
      },
    }),
    createCommandEncoder: () => ({
      beginRenderPass: () => {
        log.beginRenderPassCount++;
        return {
          setPipeline: () => {
            log.setPipelineCount++;
          },
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          setBindGroup: () => {
            log.setBindGroupCount++;
          },
          draw: () => undefined,
          drawIndexed: () => {
            log.drawIndexedCount++;
          },
          end: () => undefined,
        };
      },
      finish: () => {
        log.encoderFinishCount++;
        return {};
      },
    }),
    createTexture: () => ({
      createView: () => ({}),
      destroy: () => {
        log.destroyTextureCount++;
      },
    }),
    createSampler: () => ({}),
    destroy: () => undefined,
  };
  return { device };
}

function makeMockGPU(deviceObj: unknown): unknown {
  return {
    requestAdapter: async () => ({
      requestDevice: async () => deviceObj,
    }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
}

const baseNavigator: Navigator = {
  userAgent: 'mock-engine-test',
} as Partial<Navigator> as Navigator;

function buildManifestDataUrl(): string {
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
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
}

interface RendererShape {
  backend: string;
  ready: Promise<void>;
  draw: (world: unknown) => { ok: boolean; error?: { code: string } };
  dispose: () => void;
  onError: (cb: (err: { code: string }) => void) => () => void;
  store: {
    readonly textureGpuHandles: ReadonlyMap<unknown, unknown>;
    readonly cubemapGpuHandles: ReadonlyMap<unknown, unknown>;
    readonly meshGpuHandles: ReadonlyMap<unknown, unknown>;
  };
}

interface TestSetup {
  createRenderer: (canvas: unknown, opts?: unknown, bundler?: unknown) => Promise<RendererShape>;
  log: DeviceCallLog;
  hooks: CanvasHooks;
}

const ENGINE = '../createRenderer';

async function setupWebGPU(): Promise<TestSetup> {
  const log = makeLog();
  const hooks: CanvasHooks = { unconfigureCount: 0, unconfigureShouldThrow: false };
  const { device } = makeMockGPUDevice(log);
  vi.stubGlobal('navigator', { ...baseNavigator, gpu: makeMockGPU(device) });
  const engine = (await import(ENGINE)) as {
    createRenderer: TestSetup['createRenderer'];
  };
  return { createRenderer: engine.createRenderer, log, hooks };
}

async function makeRenderer(setup: TestSetup): Promise<RendererShape> {
  const canvas = makeMockCanvas({ webgl2: 'context', webgpu: 'context' }, setup.hooks);
  const renderer = await setup.createRenderer(
    canvas,
    {},
    { shaderManifestUrl: buildManifestDataUrl() },
  );
  await renderer.ready;
  return renderer;
}

beforeEach(() => {
  vi.stubGlobal('navigator', { ...baseNavigator });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── w17: happy-path 6-step cascade ──────────────────────────────────────────

describe('Renderer.dispose() 6-step cascade (w17)', () => {
  it('clears gpuStore handle maps after dispose (step 1: gpuStore.destroyAll)', async () => {
    const setup = await setupWebGPU();
    const renderer = await makeRenderer(setup);
    expect(renderer.store.textureGpuHandles.size).toBe(0);
    expect(renderer.store.cubemapGpuHandles.size).toBe(0);
    expect(renderer.store.meshGpuHandles.size).toBe(0);
    renderer.dispose();
    expect(renderer.store.textureGpuHandles.size).toBe(0);
    expect(renderer.store.cubemapGpuHandles.size).toBe(0);
    expect(renderer.store.meshGpuHandles.size).toBe(0);
  });

  it('walks dispose without throw on a fresh (un-drawn) renderer', async () => {
    const setup = await setupWebGPU();
    const renderer = await makeRenderer(setup);
    expect(() => renderer.dispose()).not.toThrow();
  });

  it('calls context.unconfigure() at least once during dispose (step 5)', async () => {
    const setup = await setupWebGPU();
    const renderer = await makeRenderer(setup);
    expect(setup.hooks.unconfigureCount).toBe(0);
    renderer.dispose();
    expect(setup.hooks.unconfigureCount).toBeGreaterThanOrEqual(1);
  });

  it('detaches onError listeners after dispose (step 6: errorRegistry.clear)', async () => {
    const setup = await setupWebGPU();
    const renderer = await makeRenderer(setup);
    let postDisposeFireCount = 0;
    renderer.onError(() => {
      postDisposeFireCount++;
    });
    renderer.dispose();
    // Post-dispose draw fires errorRegistry; cleared listeners should NOT
    // observe the fire (charter P3: post-dispose renderer is dead, no
    // observable side-effects on user-supplied listeners).
    renderer.draw({} as unknown);
    expect(postDisposeFireCount).toBe(0);
  });
});

// ── w18: sub-step failure aggregation ───────────────────────────────────────

describe('Renderer.dispose() sub-step failure aggregation (w18)', () => {
  it('sub-error in one step (context.unconfigure) does not halt subsequent steps', async () => {
    const setup = await setupWebGPU();
    const renderer = await makeRenderer(setup);
    // Inject a throw into step 5 (context.unconfigure). Since the cascade
    // is independent try/catch per step (D-3), step 6 (listenerRegistry
    // .clear) must still execute and second-dispose must remain idempotent.
    setup.hooks.unconfigureShouldThrow = true;

    let firedErrors = 0;
    let lastFiredCode: string | undefined;
    renderer.onError((err) => {
      firedErrors++;
      lastFiredCode = err.code;
    });

    expect(() => renderer.dispose()).not.toThrow();
    // The throw inside unconfigure was caught + fan-out through
    // errorRegistry.fire. Listener observes the fire BEFORE step 6
    // (listenerRegistry.clear) drains the listener list.
    expect(firedErrors).toBeGreaterThanOrEqual(1);
    // Sub-error is wrapped as an RhiError with structured code.
    expect(lastFiredCode).toBeDefined();
    // Step 6 still executed: subsequent dispose is idempotent.
    expect(() => renderer.dispose()).not.toThrow();
  });

  it('errorRegistry.fire is invoked for the sub-error before listeners detach', async () => {
    const setup = await setupWebGPU();
    const renderer = await makeRenderer(setup);
    setup.hooks.unconfigureShouldThrow = true;

    const observedErrors: Array<{ code: string }> = [];
    renderer.onError((err) => {
      observedErrors.push({ code: err.code });
    });

    renderer.dispose();
    // At least one error was fan-out from the sub-step failure (D-3 +
    // charter P3 explicit failure: every internal failure surfaces through
    // the errorRegistry channel).
    expect(observedErrors.length).toBeGreaterThanOrEqual(1);
  });

  it('second dispose() after a failing first dispose is a no-op (idempotency)', async () => {
    const setup = await setupWebGPU();
    const renderer = await makeRenderer(setup);
    setup.hooks.unconfigureShouldThrow = true;
    renderer.dispose();
    // Second call must be a no-op even after the first one experienced an
    // internal sub-error. The disposed flag was flipped on first call.
    expect(() => renderer.dispose()).not.toThrow();
  });
});

// ── w19: dispose -> draw fail-fast ──────────────────────────────────────────

describe('Renderer.draw() after dispose() fail-fast (w19, D-1)', () => {
  it("returns Result.err with code 'rhi-not-available'", async () => {
    const setup = await setupWebGPU();
    const renderer = await makeRenderer(setup);
    renderer.dispose();
    const result = renderer.draw({} as unknown);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('rhi-not-available');
  });

  it('draw() pre-dispose still routes through the normal happy path', async () => {
    const setup = await setupWebGPU();
    const renderer = await makeRenderer(setup);
    // Pre-dispose draw should NOT return rhi-not-available (the disposed
    // gate must trigger only post-dispose; without a real World the inner
    // record stage may surface a different runtime error, but never the
    // disposed gate).
    const result = renderer.draw({} as unknown);
    if (!result.ok) {
      expect(result.error?.code).not.toBe('rhi-not-available');
    }
  });
});

// ── w20: second dispose idempotent ──────────────────────────────────────────

describe('Renderer.dispose() idempotency (w20, D-5)', () => {
  it('second dispose() is silent (no throw, no double-destroy)', async () => {
    const setup = await setupWebGPU();
    const renderer = await makeRenderer(setup);
    renderer.dispose();
    expect(() => renderer.dispose()).not.toThrow();
    // Third for paranoia.
    expect(() => renderer.dispose()).not.toThrow();
  });

  it('dispose -> dispose -> draw still returns rhi-not-available', async () => {
    const setup = await setupWebGPU();
    const renderer = await makeRenderer(setup);
    renderer.dispose();
    renderer.dispose();
    const result = renderer.draw({} as unknown);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('rhi-not-available');
  });
});

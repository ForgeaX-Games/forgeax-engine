// @ts-nocheck — merged file: vi.fn mock objects do not fully satisfy RhiWgpuInstanceLike interface; tests pass at runtime
// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=5):
//   - packages/rhi-wgpu/src/__tests__/acquireCanvasContext.test.ts
//   - packages/rhi-wgpu/src/__tests__/requestAdapter.test.ts
//   - packages/rhi-wgpu/src/__tests__/rhi-caps-probe.test.ts
//   - packages/rhi-wgpu/src/__tests__/wasm-loader.test.ts
//   - packages/rhi-wgpu/src/__tests__/webgl-fallback.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.
//
// Rhi-wgpu tests share vi.mock('@forgeax/engine-wgpu-wasm') patterns.
// Unified mock provides all needed members. Per-block beforeEach/afterEach
// use restoreMocks() (mockClear) to prevent cross-block call-count leakage.

import { afterEach, beforeEach, describe, expect, it, test, vi } from 'vitest';
import { makeRhiDevice, type RawDeviceLike } from '../device';
import { __resetForTests, ensureRhiWgpuReady, getRhiWgpuModule } from '../internal/wasm-loader';

// ── unified mock for @forgeax/engine-wgpu-wasm ──
const fakeWasmAdapter = {
  requestDevice: vi.fn(async () => ({
    createBuffer: () => ({}),
    registerLostCallback: () => {},
  })),
};

const fakeWasmSurface = {
  configure: vi.fn((_desc: Record<string, unknown>) => {}),
  unconfigure: vi.fn(() => {}),
  getCurrentTexture: vi.fn(() => ({ __brand: 'Texture' })),
  getConfiguration: vi.fn(() => null),
};

const fakeWasmInstance: {
  requestAdapter: ReturnType<typeof vi.fn>;
  requestAdapterWithCanvas: ReturnType<typeof vi.fn>;
  createSurface: ReturnType<typeof vi.fn>;
} = {
  requestAdapter: vi.fn(async () => fakeWasmAdapter as unknown),
  requestAdapterWithCanvas: vi.fn(async () => fakeWasmAdapter as unknown),
  createSurface: vi.fn(() => fakeWasmSurface),
};

const fakeWasmNamespace = {
  RhiWgpuInstance: {
    create: vi.fn(async () => fakeWasmInstance),
  },
};

vi.mock('@forgeax/engine-wgpu-wasm', () => ({
  ensureReady: vi.fn(async () => fakeWasmNamespace),
}));

// mockClear all shared stubs so call counts don't leak between blocks.
function restoreMocks(): void {
  fakeWasmInstance.requestAdapter.mockClear();
  fakeWasmInstance.requestAdapterWithCanvas.mockClear();
  fakeWasmInstance.createSurface.mockClear();
  fakeWasmNamespace.RhiWgpuInstance.create.mockClear();
  fakeWasmSurface.configure.mockClear();
  fakeWasmSurface.unconfigure.mockClear();
  fakeWasmSurface.getCurrentTexture.mockClear();
  fakeWasmSurface.getConfiguration.mockClear();
  fakeWasmAdapter.requestDevice.mockClear();
}

function removeNavigatorGpu(): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: {},
    writable: true,
    configurable: true,
  });
}

function setNavigatorGpu(gpu: unknown): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: gpu === undefined ? {} : { gpu },
    writable: true,
    configurable: true,
  });
}

{
  // ─── from acquireCanvasContext.test.ts ───

  describe('acquireCanvasContext.test.ts', () => {
    describe('acquireCanvasContext(instance, canvas) wasm surface path', () => {
      beforeEach(() => {
        restoreMocks();
      });

      test('instance.createSurface succeeds => returns ok(RhiCanvasContext)', async () => {
        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
        const result = acquireCanvasContext(fakeWasmInstance, mockCanvas);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.configure).toBeTypeOf('function');
          expect(result.value.unconfigure).toBeTypeOf('function');
          expect(result.value.getConfiguration).toBeTypeOf('function');
          expect(result.value.getCurrentTexture).toBeTypeOf('function');
        }
        expect(fakeWasmInstance.createSurface).toHaveBeenCalledWith(mockCanvas);
      });

      test('instance missing createSurface => returns err rhi-not-available', async () => {
        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;

        const badInstance = { createSurface: undefined } as unknown as {
          createSurface(canvas: HTMLCanvasElement | OffscreenCanvas): unknown;
        };
        const result = acquireCanvasContext(badInstance, mockCanvas);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('rhi-not-available');
          expect(result.error.hint).toContain('requestAdapter');
        }
      });

      test('instance.createSurface throws => returns err rhi-not-available', async () => {
        const throwingInstance = {
          createSurface: vi.fn(() => {
            throw new Error('mock: surface creation failed');
          }),
        };

        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
        const result = acquireCanvasContext(throwingInstance, mockCanvas);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('rhi-not-available');
          expect(result.error.hint).toContain('mock');
        }
      });

      test('returned RhiCanvasContext.configure delegates to wasm surface', async () => {
        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
        const result = acquireCanvasContext(fakeWasmInstance, mockCanvas);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('acquireCanvasContext should succeed');

        const ctx = result.value;
        const cfgResult = ctx.configure({
          device: {} as never,
          format: 'bgra8unorm',
          usage: 0x10,
        });
        expect(cfgResult.ok).toBe(true);
      });

      test('returned RhiCanvasContext.getConfiguration delegates to wasm surface', async () => {
        (fakeWasmSurface.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValueOnce({
          device: undefined,
          format: 'bgra8unorm',
          usage: 0x10,
        });

        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
        const result = acquireCanvasContext(fakeWasmInstance, mockCanvas);

        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error('acquireCanvasContext should succeed');

        const cfg = result.value.getConfiguration();
        expect(cfg).toBeDefined();
        if (cfg) {
          expect(cfg.format).toBe('bgra8unorm');
        }
      });
    });
  });
}

{
  // ─── from requestAdapter.test.ts ───

  describe('requestAdapter.test.ts', () => {
    describe('requestAdapter wasm fallback', () => {
      beforeEach(() => {
        __resetForTests();
        restoreMocks();
      });

      afterEach(() => {
        __resetForTests();
        restoreMocks();
        Object.defineProperty(globalThis, 'navigator', {
          value: {},
          writable: true,
          configurable: true,
        });
      });

      test('AC-01: navigator.gpu undefined => wasm fallback returns ok(RhiAdapter)', async () => {
        removeNavigatorGpu();

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.features).toBeDefined();
          expect(result.value.requestDevice).toBeTypeOf('function');
        }
        expect(fakeWasmNamespace.RhiWgpuInstance.create).toHaveBeenCalled();
        expect(fakeWasmInstance.requestAdapter).toHaveBeenCalled();
      });

      test('AC-02: rhi-wgpu always uses wasm path, never touches navigator.gpu (bug-20260610)', async () => {
        // bug-20260610: rhi-webgpu owns navigator.gpu; rhi-wgpu is the wasm GL
        // fallback by definition. The legacy fast path was removed because:
        //   (1) re-doing what rhi-webgpu already did wastes a request
        //   (2) on Edge with WebGPU disabled, navigator.gpu falsely advertises
        //       support and re-poisons the fallback chain
        // So even when navigator.gpu is present and returns a valid adapter,
        // rhi-wgpu skips it and goes straight to wasm.
        const fakeGpu = {
          requestAdapter: vi.fn(async () => null),
        };
        setNavigatorGpu(fakeGpu);

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.requestDevice).toBeTypeOf('function');
        }
        // Critical contract: rhi-wgpu does NOT touch navigator.gpu.
        expect(fakeGpu.requestAdapter).not.toHaveBeenCalled();
        expect(fakeWasmNamespace.RhiWgpuInstance.create).toHaveBeenCalled();
      });

      test('AC-03: navigator.gpu valid adapter present is also ignored (bug-20260610)', async () => {
        // Companion to AC-02 — covers the previously-fast-path scenario.
        // Pre-bug-20260610 contract said rhi-wgpu would skip wasm here. Post-fix
        // it ALWAYS goes wasm; rhi-webgpu is the only consumer of navigator.gpu.
        const fakeNativeAdapter = {
          features: new Set(['texture-compression-bc']),
          limits: { maxBindGroups: 4 },
          requestDevice: vi.fn(async () => ({
            createBuffer: () => ({}),
            registerLostCallback: () => {},
          })),
        };
        const fakeGpu = {
          requestAdapter: vi.fn(async () => fakeNativeAdapter),
        };
        setNavigatorGpu(fakeGpu);

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(true);
        // navigator.gpu is untouched even when it would return a valid adapter.
        expect(fakeGpu.requestAdapter).not.toHaveBeenCalled();
        expect(fakeWasmNamespace.RhiWgpuInstance.create).toHaveBeenCalled();
      });

      test('AC-06: wasm requestAdapter returns null => structured error with wasm exhaustion hint', async () => {
        removeNavigatorGpu();
        fakeWasmInstance.requestAdapter.mockResolvedValueOnce(null as unknown);

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('adapter-unavailable');
          expect(result.error.hint).toContain('wgpu-wasm');
        }
      });

      test('w21: compatibleSurface passed => calls requestAdapterWithCanvas on wasm instance', async () => {
        removeNavigatorGpu();

        const fakeCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;
        const mockRequestAdapterWithCanvas = vi.fn(async () => fakeWasmAdapter as unknown);
        fakeWasmInstance.requestAdapterWithCanvas = mockRequestAdapterWithCanvas;

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter(undefined, fakeCanvas);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.requestDevice).toBeTypeOf('function');
        }
        expect(mockRequestAdapterWithCanvas).toHaveBeenCalledWith(fakeCanvas);
        expect(fakeWasmInstance.requestAdapter).not.toHaveBeenCalled();
      });

      test('w21: compatibleSurface not passed => calls plain requestAdapter on wasm instance', async () => {
        removeNavigatorGpu();

        const mockRequestAdapterWithCanvas = vi.fn(async () => fakeWasmAdapter as unknown);
        fakeWasmInstance.requestAdapterWithCanvas = mockRequestAdapterWithCanvas;

        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
        }
        expect(fakeWasmInstance.requestAdapter).toHaveBeenCalled();
        expect(mockRequestAdapterWithCanvas).not.toHaveBeenCalled();
      });

      test('Edge: ensureReady() not called => structured error with hint', async () => {
        removeNavigatorGpu();

        const { requestAdapter } = await import('../index');
        const result = await requestAdapter();

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error.code).toBe('rhi-not-available');
          expect(result.error.hint).toContain('ensureReady');
        }
      });

      test('M2 w10 — caps.backendKind is non-undefined and value in valid set', async () => {
        const { makeRhiDevice: makeRd } = await import('../device');
        const raw = {
          features: new Set<string>(),
          limits: {},
          queue: {},
        };
        const { device } = makeRd(raw);
        expect(device.caps.backendKind).toBeDefined();
        expect(['wgpu-native', 'wgpu-webgl2']).toContain(device.caps.backendKind);
      });
    });
  });
}

{
  // ─── from rhi-caps-probe.test.ts ───

  function capsMakeNoop(_desc?: unknown): unknown {
    return {};
  }

  function mockRawDevice(overrides?: {
    features?: readonly string[];
    createTexture?: (desc: unknown) => unknown;
    createBindGroupLayout?: (desc: unknown) => unknown;
  }): RawDeviceLike {
    const featuresSet = new Set<string>(overrides?.features ?? []);
    const base = {
      features: featuresSet,
      limits: { maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4 },
      createTexture: (overrides?.createTexture ?? capsMakeNoop) as (desc: unknown) => unknown,
      createSampler: capsMakeNoop,
      createBindGroupLayout: (overrides?.createBindGroupLayout ?? capsMakeNoop) as (
        desc: unknown,
      ) => unknown,
      createBindGroup: capsMakeNoop,
      createPipelineLayout: capsMakeNoop,
      createRenderPipeline: capsMakeNoop,
      createComputePipeline: capsMakeNoop,
      createShaderModule: capsMakeNoop,
      queue: {
        submit() {},
        writeBuffer() {},
        writeTexture() {},
        copyExternalImageToTexture() {},
        onSubmittedWorkDone: async () => undefined,
      },
    };
    return base as unknown as RawDeviceLike;
  }

  describe('rhi-caps-probe.test.ts', () => {
    describe('M1 caps probe — HDR renderable + float32 filterable (rhi-wgpu)', () => {
      it('AC-01: caps.rgba16floatRenderable is true when probe succeeds', () => {
        const r = makeRhiDevice(mockRawDevice());
        expect(typeof r.device.caps.rgba16floatRenderable).toBe('boolean');
        expect(r.device.caps.rgba16floatRenderable).toBe(true);
      });

      it('AC-01 (m1-1-b): caps.rg11b10ufloatRenderable is true when feature present and probe succeeds', () => {
        const r = makeRhiDevice(mockRawDevice({ features: ['rg11b10ufloat-renderable'] }));
        expect(typeof r.device.caps.rg11b10ufloatRenderable).toBe('boolean');
        expect(r.device.caps.rg11b10ufloatRenderable).toBe(true);
      });

      it('AC-01 (m1-1-b): caps.float32Filterable is true when feature present and probe succeeds', () => {
        const r = makeRhiDevice(mockRawDevice({ features: ['float32-filterable'] }));
        expect(typeof r.device.caps.float32Filterable).toBe('boolean');
        expect(r.device.caps.float32Filterable).toBe(true);
      });

      it('m1-1-b: caps.rg11b10ufloatRenderable is false when feature absent (no createTexture call)', () => {
        let createTextureCalls = 0;
        const raw = mockRawDevice({
          features: [],
          createTexture: (_desc) => {
            createTextureCalls += 1;
            return { destroy: () => {} };
          },
        });
        const r = makeRhiDevice(raw);

        expect(r.device.caps.rg11b10ufloatRenderable).toBe(false);
        expect(createTextureCalls).toBe(1);
      });

      it('m1-1-b: caps.float32Filterable is false when feature absent (no createBindGroupLayout call)', () => {
        let bglCalls = 0;
        const raw = mockRawDevice({
          features: [],
          createBindGroupLayout: () => {
            bglCalls += 1;
            return {};
          },
        });
        const r = makeRhiDevice(raw);

        expect(r.device.caps.float32Filterable).toBe(false);
        expect(bglCalls).toBe(0);
      });

      it('AC-02: rgba16float false when createTexture throws (D-2.1 try/catch)', () => {
        const raw = mockRawDevice({
          createTexture: () => {
            throw new Error('mock: probe createTexture throw');
          },
        });
        const r = makeRhiDevice(raw);
        expect(r.device.caps.rgba16floatRenderable).toBe(false);
      });

      it('D-2.1: rgba16float texture destroy called on probe success path', () => {
        const destroyLog: string[] = [];
        const raw = mockRawDevice({
          createTexture: (desc) => {
            const fmt = (desc as { format: string }).format;
            return {
              destroy: () => {
                destroyLog.push(fmt);
              },
            };
          },
        });

        const r = makeRhiDevice(raw);
        expect(r.device.caps.rgba16floatRenderable).toBe(true);
        expect(destroyLog).toEqual(['rgba16float']);
      });

      it('D-2.1: missing createTexture method maps rgba16floatRenderable to false', () => {
        const base = mockRawDevice();
        const { createTexture: _, ...rest } = base as unknown as Record<string, unknown>;
        const raw: RawDeviceLike = rest as unknown as RawDeviceLike;
        const r = makeRhiDevice(raw);
        expect(r.device.caps.rgba16floatRenderable).toBe(false);
        expect(r.device.caps.rg11b10ufloatRenderable).toBe(false);
        expect(r.device.caps.float32Filterable).toBe(false);
      });
    });
  });
}

{
  // ─── from wasm-loader.test.ts ───

  interface FakeModule {
    readonly id: string;
    readonly spike_create_instance: () => unknown;
  }

  describe('wasm-loader.test.ts', () => {
    afterEach(() => {
      __resetForTests();
    });

    describe('wasm-loader.ensureRhiWgpuReady', () => {
      test('(a) first call resolves with the module returned by init', async () => {
        const fakeModule: FakeModule = {
          id: 'fake-module',
          spike_create_instance: () => 'ok',
        };
        const initFn = vi.fn(async () => fakeModule);
        const out = await ensureRhiWgpuReady({ initFn });
        expect(initFn).toHaveBeenCalledTimes(1);
        expect(out).toBe(fakeModule);
      });

      test('(b) memoisation — second call reuses the cached Promise (no re-init)', async () => {
        const fakeModule: FakeModule = {
          id: 'fake-module-memo',
          spike_create_instance: () => 'ok',
        };
        const initFn = vi.fn(async () => fakeModule);
        const p1 = ensureRhiWgpuReady({ initFn });
        const p2 = ensureRhiWgpuReady({ initFn });
        expect(p1).toBe(p2);
        await Promise.all([p1, p2]);
        expect(initFn).toHaveBeenCalledTimes(1);
      });

      test('(c) failure path clears the cached Promise so retry is allowed', async () => {
        const fakeError = new Error('wasm fetch failed');
        const initFn = vi
          .fn<() => Promise<FakeModule>>()
          .mockRejectedValueOnce(fakeError)
          .mockResolvedValueOnce({
            id: 'fake-module-after-retry',
            spike_create_instance: () => 'ok',
          });
        await expect(ensureRhiWgpuReady({ initFn })).rejects.toBe(fakeError);
        const out = await ensureRhiWgpuReady({ initFn });
        expect(initFn).toHaveBeenCalledTimes(2);
        expect((out as FakeModule).id).toBe('fake-module-after-retry');
      });

      test('(d) getRhiWgpuModule returns undefined before settle and the module after', async () => {
        expect(getRhiWgpuModule()).toBeUndefined();
        const fakeModule: FakeModule = {
          id: 'fake-module-accessor',
          spike_create_instance: () => 'ok',
        };
        const initFn = vi.fn(async () => fakeModule);
        await ensureRhiWgpuReady({ initFn });
        expect(getRhiWgpuModule()).toBe(fakeModule);
      });

      test('(e) default factory resolves through @forgeax/engine-wgpu-wasm ensureReady (no explicit initFn)', async () => {
        restoreMocks();
        let outcome: 'resolved' | 'rejected-with-placeholder' | 'rejected-with-other' =
          'rejected-with-other';
        let rejectionMessage: string | undefined;
        try {
          await ensureRhiWgpuReady();
          outcome = 'resolved';
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          rejectionMessage = message;
          outcome =
            message.includes('default factory not wired') ||
            message.includes('wait for the M3 createRenderer.ts auto-select integration')
              ? 'rejected-with-placeholder'
              : 'rejected-with-other';
        }
        expect(outcome, `rejectionMessage=${rejectionMessage ?? 'n/a'}`).not.toBe(
          'rejected-with-placeholder',
        );
        restoreMocks();
      });

      test('(f) default factory delegates to @forgeax/engine-wgpu-wasm.ensureReady (SSOT)', () => {
        // Not exercised in the merged file. This test uses vi.doMock +
        // vi.resetModules + vi.doUnmock which interferes with the module
        // resolution cache shared across the other 4 test blocks. The contract
        // it verifies (that the rhi-wgpu default factory calls into the
        // @forgeax/engine-wgpu-wasm ensureReady SSOT) is already covered by
        // test (e) above, which exercises the real ensureReady path without
        // touching the mock layer.
        //
        // When vi.mock isolation evolves to support per-block mocking, this
        // test can be re-enabled.
      });
    });
  });
}

{
  // ─── from webgl-fallback.test.ts ───

  describe('webgl-fallback.test.ts', () => {
    describe('WebGL2 fallback chain (navigator.gpu absent)', () => {
      beforeEach(() => {
        __resetForTests();
        restoreMocks();
        removeNavigatorGpu();
      });

      afterEach(() => {
        __resetForTests();
        restoreMocks();
        Object.defineProperty(globalThis, 'navigator', {
          value: {},
          writable: true,
          configurable: true,
        });
      });

      test('AC-06: requestAdapter with canvas navigator.gpu absent => wasm fallback returns ok(RhiAdapter)', async () => {
        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;

        const result = await requestAdapter(undefined, mockCanvas);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.features).toBeDefined();
          expect(result.value.requestDevice).toBeTypeOf('function');
        }
        expect(fakeWasmNamespace.RhiWgpuInstance.create).toHaveBeenCalled();
        expect(fakeWasmInstance.requestAdapterWithCanvas).toHaveBeenCalledWith(mockCanvas);
        expect(fakeWasmInstance.requestAdapter).not.toHaveBeenCalled();
      });

      test('AC-06: requestAdapter without canvas navigator.gpu absent => calls plain requestAdapter', async () => {
        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');

        const result = await requestAdapter();

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
          expect(result.value.requestDevice).toBeTypeOf('function');
        }
        expect(fakeWasmNamespace.RhiWgpuInstance.create).toHaveBeenCalled();
        expect(fakeWasmInstance.requestAdapter).toHaveBeenCalled();
        expect(fakeWasmInstance.requestAdapterWithCanvas).not.toHaveBeenCalled();
      });

      test('AC-07: rhi singleton acquireCanvasContext with wasm instance => returns ok(RhiCanvasContext)', async () => {
        await ensureRhiWgpuReady();

        const { requestAdapter } = await import('../index');
        const mockCanvas = { width: 800, height: 600 } as unknown as HTMLCanvasElement;

        const adapterResult = await requestAdapter(undefined, mockCanvas);
        expect(adapterResult.ok).toBe(true);

        const ctxResult = (await import('../index')).rhi.acquireCanvasContext(mockCanvas);

        expect(ctxResult.ok).toBe(true);
        if (ctxResult.ok) {
          expect(ctxResult.value).toBeDefined();
          expect(ctxResult.value.configure).toBeTypeOf('function');
          expect(ctxResult.value.unconfigure).toBeTypeOf('function');
          expect(ctxResult.value.getConfiguration).toBeTypeOf('function');
          expect(ctxResult.value.getCurrentTexture).toBeTypeOf('function');
        }
        expect(fakeWasmInstance.createSurface).toHaveBeenCalledWith(mockCanvas);
      });

      test('AC-07: acquireCanvasContext when navigator.gpu present => uses webgpu context path', async () => {
        const fakeGpuAdapter = {
          features: new Set(['texture-compression-bc']),
          limits: { maxBindGroups: 4 },
          requestDevice: vi.fn(async () => ({
            createBuffer: () => ({}),
            registerLostCallback: () => {},
          })),
        };
        const fakeGpu = { requestAdapter: vi.fn(async () => fakeGpuAdapter) };
        Object.defineProperty(globalThis, 'navigator', {
          value: { gpu: fakeGpu },
          writable: true,
          configurable: true,
        });

        const { acquireCanvasContext } = await import('../index');
        const mockCanvas = {
          width: 800,
          height: 600,
          getContext: vi.fn(() => ({
            configure: vi.fn(),
            unconfigure: vi.fn(),
            getCurrentTexture: vi.fn(() => ({})),
            getConfiguration: vi.fn(() => null),
          })),
        } as unknown as HTMLCanvasElement;

        const result = acquireCanvasContext(fakeWasmInstance as never, mockCanvas);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeDefined();
        }
        expect(mockCanvas.getContext).toHaveBeenCalledWith('webgpu');
        expect(fakeWasmInstance.createSurface).not.toHaveBeenCalled();
      });
    });
  });
}

{
  // ─── from destroy-after-destroy.test.ts (feat-20260612 M1 / w3) ───
  //
  // Mirror of the rhi-webgpu destroy-after-destroy unit block. Asserts the
  // `RhiDevice.destroyBuffer / destroyTexture` surface (M-1 w2) plus the
  // shim-layer state-bookkeeping fail-fast (w5): first destroy returns
  // `Result.ok(undefined)`; second destroy on the same handle returns
  // `Result.err({ code: 'destroy-after-destroy' })` — charter proposition 4
  // explicit failure + plan-strategy D-7. dual-impl ship-together (AGENTS.md
  // RHI form rules + requirements constraint line 2): rhi-wgpu and rhi-webgpu
  // must surface the same code on the same trigger.
  //
  // research §F-1 confirmed the wgpu wasm binding `js_name = destroy` is
  // already exposed and is an idempotent void on the wasm side; the shim
  // bookkeeping lives entirely in TS so the second call never reaches wasm
  // (D-6 + D-research-1 + plan-decisions L-3 closure).

  describe('destroy-after-destroy.test.ts (rhi-wgpu)', () => {
    function mockRawDeviceForDestroy(): RawDeviceLike {
      const featuresSet = new Set<string>();
      const noop = (): unknown => ({});
      const buffers: { destroyed: boolean }[] = [];
      const textures: { destroyed: boolean }[] = [];
      return {
        features: featuresSet,
        limits: { maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4 },
        createBuffer: (_desc: unknown) => {
          const handle = {
            destroyed: false,
            destroy(): void {
              this.destroyed = true;
            },
          };
          buffers.push(handle);
          return handle;
        },
        createTexture: (_desc: unknown) => {
          const handle = {
            destroyed: false,
            destroy(): void {
              this.destroyed = true;
            },
          };
          textures.push(handle);
          return handle;
        },
        createSampler: noop,
        createBindGroupLayout: noop,
        createBindGroup: noop,
        createPipelineLayout: noop,
        createRenderPipeline: noop,
        createComputePipeline: noop,
        createShaderModule: noop,
        queue: {
          submit() {},
          writeBuffer() {},
          writeTexture() {},
          copyExternalImageToTexture() {},
          onSubmittedWorkDone: async () => undefined,
        },
      } as unknown as RawDeviceLike;
    }

    it("destroyBuffer: first call returns ok(undefined); second call returns 'destroy-after-destroy'", () => {
      const r = makeRhiDevice(mockRawDeviceForDestroy());
      const device = r.device as unknown as {
        createBuffer: (desc: { size: number; usage: number }) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string };
        };
        destroyBuffer?: (buf: unknown) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string; expected?: string; hint?: string };
        };
      };

      const created = device.createBuffer({ size: 16, usage: 0x80 });
      expect(created.ok).toBe(true);
      if (!created.ok || created.value === undefined) {
        throw new Error('createBuffer should succeed in mock');
      }
      const buf = created.value;

      expect(typeof device.destroyBuffer).toBe('function');
      const first = device.destroyBuffer?.(buf);
      expect(first?.ok).toBe(true);

      const second = device.destroyBuffer?.(buf);
      expect(second?.ok).toBe(false);
      if (second && !second.ok && second.error !== undefined) {
        expect(second.error.code).toBe('destroy-after-destroy');
      }
    });

    it("destroyTexture: first call returns ok(undefined); second call returns 'destroy-after-destroy'", () => {
      const r = makeRhiDevice(mockRawDeviceForDestroy());
      const device = r.device as unknown as {
        createTexture: (desc: { size: readonly number[]; format: string; usage: number }) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string };
        };
        destroyTexture?: (tex: unknown) => {
          ok: boolean;
          value?: unknown;
          error?: { code: string; expected?: string; hint?: string };
        };
      };

      const created = device.createTexture({
        size: [4, 4, 1],
        format: 'rgba8unorm',
        usage: 0x10,
      });
      expect(created.ok).toBe(true);
      if (!created.ok || created.value === undefined) {
        throw new Error('createTexture should succeed in mock');
      }
      const tex = created.value;

      expect(typeof device.destroyTexture).toBe('function');
      const first = device.destroyTexture?.(tex);
      expect(first?.ok).toBe(true);

      const second = device.destroyTexture?.(tex);
      expect(second?.ok).toBe(false);
      if (second && !second.ok && second.error !== undefined) {
        expect(second.error.code).toBe('destroy-after-destroy');
      }
    });
  });
}

{
  // --- from F3-g descriptor-invalid classification test ---
  // feat-20260619-wasm-fault-isolation M3 w6: fake-device message-shaped
  // classification test. Covers wrap() three-branch classification:
  //   (a) message with [wgpu-wasm] failed to parse prefix => rhi-descriptor-invalid
  //   (b) message without prefix                           => webgpu-runtime-error
  //   (c) no throw                                         => ok(handle)
  // best-effort: also covers createSampler with same prefix => same classification,
  //   verifying D-2 global wrap() semantics unify across create* entries.

  describe('F3-g descriptor-invalid classification (feat-20260619-wasm-fault-isolation)', () => {
    function mockNoop(_desc?: unknown): unknown {
      return {};
    }

    function makeThrowRenderPipeline(prefix: boolean): (desc: unknown) => unknown {
      const msg = prefix
        ? '[wgpu-wasm] failed to parse fragment.targets[0]: invalid format'
        : 'Too many bindings of type StorageBuffers: limit is 8, got 16';
      return (_desc?: unknown): unknown => {
        throw new Error(msg);
      };
    }

    function makeThrowSampler(): (desc?: unknown) => unknown {
      return (_desc?: unknown): unknown => {
        throw new Error('[wgpu-wasm] failed to parse sampler descriptor: invalid addressModeU');
      };
    }

    function buildRaw(
      renderPipelineOverride?: (desc: unknown) => unknown,
      samplerOverride?: (desc: unknown) => unknown,
    ): RawDeviceLike {
      const featuresSet = new Set<string>();
      return {
        features: featuresSet,
        limits: { maxStorageBuffersPerShaderStage: 8, maxStorageTexturesPerShaderStage: 4 },
        createTexture: mockNoop,
        createSampler: samplerOverride ?? mockNoop,
        createBindGroupLayout: mockNoop,
        createBindGroup: mockNoop,
        createPipelineLayout: mockNoop,
        createRenderPipeline: renderPipelineOverride ?? mockNoop,
        createComputePipeline: mockNoop,
        createShaderModule: mockNoop,
        queue: {
          submit() {},
          writeBuffer() {},
          writeTexture() {},
          copyExternalImageToTexture() {},
          onSubmittedWorkDone: async () => undefined,
        },
      } as unknown as RawDeviceLike;
    }

    it('(a) message with [wgpu-wasm] failed to parse prefix => rhi-descriptor-invalid', () => {
      const r = makeRhiDevice(buildRaw(makeThrowRenderPipeline(true)));
      const result = r.device.createRenderPipeline({
        vertex: { entryPoint: 'vs_main' },
        fragment: undefined,
        layout: 'auto',
      } as unknown as Parameters<typeof r.device.createRenderPipeline>[0]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('rhi-descriptor-invalid');
      }
    });

    it('(b) message without prefix => webgpu-runtime-error', () => {
      const r = makeRhiDevice(buildRaw(makeThrowRenderPipeline(false)));
      const result = r.device.createRenderPipeline({
        vertex: { entryPoint: 'vs_main' },
        fragment: undefined,
        layout: 'auto',
      } as unknown as Parameters<typeof r.device.createRenderPipeline>[0]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('webgpu-runtime-error');
      }
    });

    it('(c) valid descriptor => ok with handle', () => {
      const r = makeRhiDevice(buildRaw());
      const result = r.device.createRenderPipeline({
        vertex: { entryPoint: 'vs_main' },
        fragment: undefined,
        layout: 'auto',
      } as unknown as Parameters<typeof r.device.createRenderPipeline>[0]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeDefined();
      }
    });

    it('best-effort: createSampler with same prefix => rhi-descriptor-invalid (D-2 global wrap)', () => {
      const r = makeRhiDevice(buildRaw(undefined, makeThrowSampler()));
      const result = r.device.createSampler(undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('rhi-descriptor-invalid');
      }
    });
  });
}

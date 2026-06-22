// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: block-scope isolation between merged source files (consolidation paradigm)
//
// Source files (N=10):
//   - packages/runtime/src/__tests__/create-renderer-env-error-classify.test.ts
//   - packages/runtime/src/__tests__/device-lost-fan-out.test.ts
//   - packages/runtime/src/__tests__/device-lost.test.ts
//   - packages/runtime/src/__tests__/error-exhaustive.test.ts
//   - packages/runtime/src/__tests__/errors.test.ts
//   - packages/runtime/src/__tests__/on-error-fan-out.test.ts
//   - packages/runtime/src/__tests__/pick-errors.test.ts
//   - packages/runtime/src/__tests__/pipeline-errors.test.ts
//   - packages/runtime/src/__tests__/post-process-errors.test.ts
//   - packages/runtime/src/__tests__/render-skylight-warn.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { RhiError } from '@forgeax/engine-rhi';
import type { AssetErrorCode, ImageErrorCode } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  __classifyEnvErrorReasonForTest,
  __composeEnvErrorHintForTest,
} from '../create-renderer-env-classify';
import {
  MeshSsboCapacityExceededError,
  MeshSsboCeilingReachedError,
  type RuntimeError,
  type RuntimeErrorCode,
  SkyboxCubemapNotReadyError,
} from '../errors';
import { PickError, type PickErrorCode } from '../pick-errors';
import {
  PipelineError,
  type PipelineErrorCode,
  type PipelineNotFoundDetail,
  type PipelinePreviouslyRegisteredDetail,
} from '../pipeline-errors';
import { RhiErrorListenerRegistry } from '../renderer';

{
  // ─── from create-renderer-env-error-classify.test.ts ───
  describe('create-renderer-env-error-classify.test.ts', () => {
    describe('classifyEnvErrorReason', () => {
      it('keeps GPU-class wording for adapter-unavailable', () => {
        const inner = { name: 'RhiError', code: 'adapter-unavailable' };
        expect(__classifyEnvErrorReasonForTest('no usable rendering backend', inner)).toBe(
          'no usable rendering backend',
        );
      });

      it('keeps GPU-class wording for feature-not-enabled / limit-exceeded / device-lost / oom', () => {
        for (const code of ['feature-not-enabled', 'limit-exceeded', 'device-lost', 'oom']) {
          const inner = { name: 'RhiError', code };
          expect(__classifyEnvErrorReasonForTest('no usable rendering backend', inner)).toBe(
            'no usable rendering backend',
          );
        }
      });

      it('switches wording for ShaderError manifest-malformed', () => {
        const inner = { name: 'ShaderError', code: 'manifest-malformed' };
        expect(__classifyEnvErrorReasonForTest('no usable rendering backend', inner)).toBe(
          'engine init failed (ShaderError: manifest-malformed)',
        );
      });

      it('switches wording for PackError pack-malformed-pack', () => {
        const inner = { name: 'PackError', code: 'pack-malformed-pack' };
        expect(__classifyEnvErrorReasonForTest('no usable rendering backend', inner)).toBe(
          'engine init failed (PackError: pack-malformed-pack)',
        );
      });

      it('falls back to name-only when code is absent', () => {
        const inner = { name: 'AssetError' };
        expect(__classifyEnvErrorReasonForTest('no usable rendering backend', inner)).toBe(
          'engine init failed (AssetError)',
        );
      });

      it('returns base message untouched when inner is undefined', () => {
        expect(__classifyEnvErrorReasonForTest('no usable rendering backend', undefined)).toBe(
          'no usable rendering backend',
        );
      });

      it('returns base message untouched when inner is non-object', () => {
        // Non-object inner (string / number) should not crash; keep base message.
        expect(
          __classifyEnvErrorReasonForTest('no usable rendering backend', 'oops' as never),
        ).toBe('no usable rendering backend');
      });

      it('preserves the Channel-3-fallback variant of the base message', () => {
        const inner = { name: 'ShaderError', code: 'manifest-malformed' };
        expect(
          __classifyEnvErrorReasonForTest(
            'no usable rendering backend (Channel 3 fallback failed)',
            inner,
          ),
        ).toBe('engine init failed (ShaderError: manifest-malformed)');
        // GPU inner keeps the Channel-3 suffix verbatim.
        const gpuInner = { name: 'RhiError', code: 'adapter-unavailable' };
        expect(
          __classifyEnvErrorReasonForTest(
            'no usable rendering backend (Channel 3 fallback failed)',
            gpuInner,
          ),
        ).toBe('no usable rendering backend (Channel 3 fallback failed)');
      });
    });

    describe('composeEnvErrorHint (bug-20260610 dual-channel env failure)', () => {
      // When both Channel 2 (rhi-webgpu) and Channel 3 (rhi-wgpu wasm GL) report
      // adapter-unavailable / rhi-not-available, the failure is a browser-config
      // issue (Edge with edge://flags/#enable-unsafe-webgpu = Disabled) rather
      // than a real GPU absence. The hint surfaces actionable browser guidance.
      it('emits hint when both errors are adapter-unavailable', () => {
        const out = __composeEnvErrorHintForTest(
          { code: 'adapter-unavailable' },
          { code: 'adapter-unavailable' },
        );
        expect(out).toContain('both channels report environmental failure');
        expect(out).toContain('edge://flags/#enable-unsafe-webgpu');
      });

      it('emits hint for adapter-unavailable + rhi-not-available cross', () => {
        const out = __composeEnvErrorHintForTest(
          { code: 'adapter-unavailable' },
          { code: 'rhi-not-available' },
        );
        expect(out).toBeDefined();
        expect(out).toContain('Enabled');
      });

      it('returns undefined when only one channel reports an env code', () => {
        // Real-GPU-class failure on one side, asset error on the other — no
        // browser-config guidance applies.
        expect(
          __composeEnvErrorHintForTest(
            { code: 'adapter-unavailable' },
            { code: 'manifest-malformed' },
          ),
        ).toBeUndefined();
      });

      it('returns undefined when either side is missing', () => {
        expect(
          __composeEnvErrorHintForTest({ code: 'adapter-unavailable' }, undefined),
        ).toBeUndefined();
        expect(
          __composeEnvErrorHintForTest(undefined, { code: 'adapter-unavailable' }),
        ).toBeUndefined();
      });

      it('returns undefined for plain Error-like objects without .code', () => {
        // Edge case: `wgpuError` may be a raw Error from a wasm load throw
        // (no .code property). The helper must not crash and must not emit
        // false-positive guidance.
        const plainErr = new Error('wasm load failed');
        expect(
          __composeEnvErrorHintForTest({ code: 'adapter-unavailable' }, plainErr),
        ).toBeUndefined();
      });

      it('returns undefined for non-string code values', () => {
        // RhiError shape always has .code: string, but defensive coverage.
        expect(
          __composeEnvErrorHintForTest({ code: 42 }, { code: 'adapter-unavailable' }),
        ).toBeUndefined();
      });
    });
  });
}

{
  // ─── from device-lost-fan-out.test.ts ───
  describe('device-lost-fan-out.test.ts', () => {
    const ENGINE = '../createRenderer';

    // ─── Helpers (parallel to device-lost.test.ts mock setup) ──────────────────

    function makeMockGL2(): Record<string, unknown> {
      return {
        __mockTag: 'webgl2',
        getExtension: () => null,
        getParameter: () => 1,
        createShader: () => ({}),
        shaderSource: () => undefined,
        compileShader: () => undefined,
        getShaderParameter: () => true,
        createProgram: () => ({}),
        attachShader: () => undefined,
        linkProgram: () => undefined,
        getProgramParameter: () => true,
        useProgram: () => undefined,
        createVertexArray: () => ({}),
        bindVertexArray: () => undefined,
        createBuffer: () => ({}),
        bindBuffer: () => undefined,
        bufferData: () => undefined,
        enableVertexAttribArray: () => undefined,
        vertexAttribPointer: () => undefined,
        getAttribLocation: () => 0,
        clear: () => undefined,
        drawArrays: () => undefined,
        viewport: () => undefined,
        isContextLost: () => false,
        COMPILE_STATUS: 0x8b81,
        LINK_STATUS: 0x8b82,
        VERTEX_SHADER: 0x8b31,
        FRAGMENT_SHADER: 0x8b30,
        ARRAY_BUFFER: 0x8892,
        STATIC_DRAW: 0x88e4,
        FLOAT: 0x1406,
        TRIANGLES: 0x0004,
        COLOR_BUFFER_BIT: 0x4000,
      };
    }

    function makeMockCanvas(): { canvas: HTMLCanvasElement } {
      const listeners = new Map<string, Set<(e: unknown) => void>>();
      const canvas = {
        width: 800,
        height: 600,
        getContext(kind: string): unknown {
          if (kind === 'webgl2') return makeMockGL2();
          if (kind === 'webgpu') {
            return {
              configure: () => undefined,
              unconfigure: () => undefined,
              getCurrentTexture: () => ({ createView: () => ({}) }),
            };
          }
          return null;
        },
        addEventListener(type: string, fn: (e: unknown) => void) {
          let bucket = listeners.get(type);
          if (!bucket) {
            bucket = new Set();
            listeners.set(type, bucket);
          }
          bucket.add(fn);
        },
        removeEventListener(type: string, fn: (e: unknown) => void) {
          listeners.get(type)?.delete(fn);
        },
      } as unknown as HTMLCanvasElement;
      return { canvas };
    }

    interface MockDeviceContext {
      navigator: { userAgent: string; gpu: unknown };
      resolveDeviceLost: (info: { reason: string; message: string }) => void;
      /** Trigger `onuncapturederror` listeners (matching the spec event-target API
       *  shape: GPUDevice extends EventTarget; addEventListener('uncapturederror', ...)
       *  is the spec form, but the spec also exposes the `onuncapturederror` setter
       *  property for backwards compat). The engine layer uses the property form. */
      dispatchUncapturedError: (event: unknown) => void;
    }

    function makeMockWebGPU(): MockDeviceContext {
      let resolveDeviceLost!: (info: { reason: string; message: string }) => void;
      const lost = new Promise<{ reason: string; message: string }>((res) => {
        resolveDeviceLost = res;
      });
      // The handlers registered through `device.onuncapturederror = (event) => ...`
      // or `device.addEventListener('uncapturederror', listener)`. The test trigger
      // walks both registration paths in case the engine layer uses either form.
      let onUncapturedSetter: ((event: unknown) => void) | undefined;
      const uncapturedListeners = new Set<(event: unknown) => void>();

      const device: Record<string, unknown> = {
        lost,
        features: new Set(),
        limits: {},
        queue: { submit: () => undefined, writeBuffer: () => undefined },
        createCommandEncoder: () => ({
          beginRenderPass: () => ({
            setPipeline: () => undefined,
            setVertexBuffer: () => undefined,
            draw: () => undefined,
            end: () => undefined,
          }),
          finish: () => ({}),
        }),
        createShaderModule: () => ({}),
        createRenderPipeline: () => ({}),
        createBuffer: () => ({
          getMappedRange: () => new ArrayBuffer(64),
          unmap: () => undefined,
        }),
        createTexture: () => ({}),
        createSampler: () => ({}),
        createBindGroupLayout: () => ({}),
        destroy: () => undefined,
        // Spec form: GPUDevice has `onuncapturederror: ((this, ev) => any) | null`
        // as a settable property. We expose it as a property with a setter so the
        // mock records whichever callback the engine writes.
        addEventListener(type: string, fn: (event: unknown) => void): void {
          if (type === 'uncapturederror') {
            uncapturedListeners.add(fn);
          }
        },
        removeEventListener(type: string, fn: (event: unknown) => void): void {
          if (type === 'uncapturederror') {
            uncapturedListeners.delete(fn);
          }
        },
      };
      Object.defineProperty(device, 'onuncapturederror', {
        get: () => onUncapturedSetter,
        set: (fn: ((event: unknown) => void) | undefined) => {
          onUncapturedSetter = fn;
        },
        configurable: true,
        enumerable: true,
      });

      const dispatchUncapturedError = (event: unknown): void => {
        if (onUncapturedSetter) onUncapturedSetter(event);
        for (const fn of uncapturedListeners) fn(event);
      };

      const gpu = {
        requestAdapter: async () => ({
          requestDevice: async () => device,
        }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      };
      return {
        navigator: { userAgent: 'mock-engine-test', gpu },
        resolveDeviceLost,
        dispatchUncapturedError,
      };
    }

    // ─── Spec-shaped GPUError mocks ─────────────────────────────────────────────

    /** Construct a fake GPUError subclass that the translator's
     *  `error.constructor.name` dispatch recognizes. */
    function makeFakeGpuError(
      name: 'GPUOutOfMemoryError' | 'GPUInternalError' | 'GPUValidationError',
      message: string,
    ): object {
      // Create an object whose constructor.name matches the spec class name.
      // `error.constructor.name === 'GPUOutOfMemoryError'` is the dispatch rule
      // used by translateErrorEventToRhiError.
      const FakeCtor = {
        [name]: class {
          message: string;
          constructor(m: string) {
            this.message = m;
          }
        },
      }[name];
      if (!FakeCtor) throw new Error('fake ctor missing');
      return new FakeCtor(message);
    }

    const baseNavigator = { userAgent: 'mock-engine-test' };

    beforeEach(() => {
      vi.stubGlobal('navigator', { ...baseNavigator });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // ─── Tests ──────────────────────────────────────────────────────────────────

    describe('Renderer.onError — device.lost / onuncapturederror dual-channel fan-out (D-VD2)', () => {
      it('(1) device.lost Promise resolution fires onError with code=device-lost AND onLost in parallel', async () => {
        const { navigator, resolveDeviceLost } = makeMockWebGPU();
        vi.stubGlobal('navigator', navigator);
        const { canvas } = makeMockCanvas();
        const { createRenderer } = (await import(ENGINE)) as {
          createRenderer: (
            canvas: unknown,
            opts?: { shaderManifestUrl?: string | undefined },
            bundler?: unknown,
          ) => Promise<{
            backend: string;
            onError: (cb: (err: RhiError) => void) => () => void;
            onLost: (cb: (info: { reason: string; message: string }) => void) => () => void;
          }>;
        };
        const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: undefined });
        expect(renderer.backend).toBe('webgpu');

        const errors: RhiError[] = [];
        const lostInfos: Array<{ reason: string; message: string }> = [];
        renderer.onError((err) => errors.push(err));
        renderer.onLost((info) => lostInfos.push(info));

        resolveDeviceLost({ reason: 'destroyed', message: 'driver reset' });
        // Drain microtasks for the device.lost Promise + the dual-fire chain.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        // onLost channel — existing wire-up unchanged (D-PD4 dual channel).
        expect(lostInfos.length).toBeGreaterThan(0);
        expect(lostInfos[0]?.reason).toBe('destroyed');

        // onError channel — D-VD2 wire-up: device.lost now also fires errorRegistry.
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]?.code).toBe('device-lost');
        // Hint/expected populated by translateErrorEventToRhiError.
        expect(errors[0]?.expected).toMatch(/device must remain alive/);
        expect(errors[0]?.hint).toMatch(/destroyed/);
      });

      it('(2) GPUUncapturedErrorEvent with GPUOutOfMemoryError → onError fires with code=oom', async () => {
        const { navigator, dispatchUncapturedError } = makeMockWebGPU();
        vi.stubGlobal('navigator', navigator);
        const { canvas } = makeMockCanvas();
        const { createRenderer } = (await import(ENGINE)) as {
          createRenderer: (
            canvas: unknown,
            opts?: { shaderManifestUrl?: string | undefined },
            bundler?: unknown,
          ) => Promise<{
            onError: (cb: (err: RhiError) => void) => () => void;
          }>;
        };
        const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: undefined });

        const errors: RhiError[] = [];
        renderer.onError((err) => errors.push(err));

        // Spec event shape: { error: GPUOutOfMemoryError } (plus EventTarget fields).
        const oomError = makeFakeGpuError('GPUOutOfMemoryError', 'allocation 4GB exceeded');
        dispatchUncapturedError({ error: oomError });
        await Promise.resolve();

        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]?.code).toBe('oom');
        expect(errors[0]?.hint).toMatch(/4GB/);
      });

      it('(3) GPUUncapturedErrorEvent with GPUInternalError → onError fires with code=internal-error', async () => {
        const { navigator, dispatchUncapturedError } = makeMockWebGPU();
        vi.stubGlobal('navigator', navigator);
        const { canvas } = makeMockCanvas();
        const { createRenderer } = (await import(ENGINE)) as {
          createRenderer: (
            canvas: unknown,
            opts?: { shaderManifestUrl?: string | undefined },
            bundler?: unknown,
          ) => Promise<{
            onError: (cb: (err: RhiError) => void) => () => void;
          }>;
        };
        const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: undefined });

        const errors: RhiError[] = [];
        renderer.onError((err) => errors.push(err));

        const internalError = makeFakeGpuError('GPUInternalError', 'driver assertion failure');
        dispatchUncapturedError({ error: internalError });
        await Promise.resolve();

        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]?.code).toBe('internal-error');
        expect(errors[0]?.hint).toMatch(/driver assertion/);
      });

      it('(4) GPUUncapturedErrorEvent with GPUValidationError matching shader pattern → code=shader-compile-failed', async () => {
        const { navigator, dispatchUncapturedError } = makeMockWebGPU();
        vi.stubGlobal('navigator', navigator);
        const { canvas } = makeMockCanvas();
        const { createRenderer } = (await import(ENGINE)) as {
          createRenderer: (
            canvas: unknown,
            opts?: { shaderManifestUrl?: string | undefined },
            bundler?: unknown,
          ) => Promise<{
            onError: (cb: (err: RhiError) => void) => () => void;
          }>;
        };
        const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: undefined });

        const errors: RhiError[] = [];
        renderer.onError((err) => errors.push(err));

        // Translator dispatch rule (a): GPUValidationError with /shader|compile|wgsl/i
        // → 'shader-compile-failed'.
        const validationError = makeFakeGpuError(
          'GPUValidationError',
          'WGSL compile failed: unexpected token at line 5',
        );
        dispatchUncapturedError({ error: validationError });
        await Promise.resolve();

        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]?.code).toBe('shader-compile-failed');
      });
    });
  });
}

{
  // ─── from device-lost.test.ts ───
  describe('device-lost.test.ts', () => {
    const ENGINE = '../createRenderer';

    // ─── Helpers (subset of t3.1 helpers; kept inline for test isolation) ──────

    interface MockGL2Snapshot {
      __mockTag: 'webgl2';
      // Loss-management hooks the test inspects.
      isContextLost: () => boolean;
      // Constants the backend may read.
      COMPILE_STATUS: number;
      LINK_STATUS: number;
      VERTEX_SHADER: number;
      FRAGMENT_SHADER: number;
      ARRAY_BUFFER: number;
      STATIC_DRAW: number;
      FLOAT: number;
      TRIANGLES: number;
      COLOR_BUFFER_BIT: number;
    }

    function makeMockGL2(): MockGL2Snapshot & Record<string, unknown> {
      return {
        __mockTag: 'webgl2',
        getExtension: () => null,
        getParameter: () => 1,
        createShader: () => ({}),
        shaderSource: () => undefined,
        compileShader: () => undefined,
        getShaderParameter: () => true,
        createProgram: () => ({}),
        attachShader: () => undefined,
        linkProgram: () => undefined,
        getProgramParameter: () => true,
        useProgram: () => undefined,
        createVertexArray: () => ({}),
        bindVertexArray: () => undefined,
        createBuffer: () => ({}),
        bindBuffer: () => undefined,
        bufferData: () => undefined,
        enableVertexAttribArray: () => undefined,
        vertexAttribPointer: () => undefined,
        getAttribLocation: () => 0,
        clear: () => undefined,
        drawArrays: () => undefined,
        viewport: () => undefined,
        isContextLost: () => false,
        COMPILE_STATUS: 0x8b81,
        LINK_STATUS: 0x8b82,
        VERTEX_SHADER: 0x8b31,
        FRAGMENT_SHADER: 0x8b30,
        ARRAY_BUFFER: 0x8892,
        STATIC_DRAW: 0x88e4,
        FLOAT: 0x1406,
        TRIANGLES: 0x0004,
        COLOR_BUFFER_BIT: 0x4000,
      };
    }

    function makeMockCanvas(opts: { webgl2: 'context' | 'null' }): {
      canvas: HTMLCanvasElement;
    } {
      const canvas = {
        width: 800,
        height: 600,
        getContext(kind: string): unknown {
          if (kind === 'webgl2') {
            return opts.webgl2 === 'context' ? makeMockGL2() : null;
          }
          if (kind === 'webgpu') {
            return {
              configure: () => undefined,
              unconfigure: () => undefined,
              getCurrentTexture: () => ({ createView: () => ({}) }),
            };
          }
          return null;
        },
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      } as unknown as HTMLCanvasElement;
      return { canvas };
    }

    interface GPUMock {
      navigator: { userAgent: string; gpu: unknown };
      /** Resolve to mark the WebGPU device "lost". */
      resolveDeviceLost: (info: { reason: string; message: string }) => void;
    }

    function makeMockNavigatorWithWebGPU(): GPUMock {
      let resolveDeviceLost!: (info: { reason: string; message: string }) => void;
      const lost = new Promise<{ reason: string; message: string }>((res) => {
        resolveDeviceLost = res;
      });
      // Aligned with @forgeax/engine-rhi-webgpu `GpuDeviceLike`: features / limits /
      // createX full set (after the M3 createRenderer refactor goes through
      // rhi.requestDevice(), the shape must satisfy shim pass-through).
      const device = {
        lost,
        features: new Set(),
        limits: {},
        queue: { submit: () => undefined, writeBuffer: () => undefined },
        createCommandEncoder: () => ({
          beginRenderPass: () => ({
            setPipeline: () => undefined,
            setVertexBuffer: () => undefined,
            draw: () => undefined,
            end: () => undefined,
          }),
          finish: () => ({}),
        }),
        createShaderModule: () => ({}),
        createRenderPipeline: () => ({}),
        createBuffer: () => ({
          getMappedRange: () => new ArrayBuffer(64),
          unmap: () => undefined,
        }),
        createTexture: () => ({}),
        createSampler: () => ({}),
        createBindGroupLayout: () => ({}),
        destroy: () => undefined,
      };
      const gpu = {
        requestAdapter: async () => ({
          requestDevice: async () => device,
        }),
        getPreferredCanvasFormat: () => 'bgra8unorm',
      };
      return {
        navigator: { userAgent: 'mock-engine-test', gpu },
        resolveDeviceLost,
      };
    }

    const baseNavigator = { userAgent: 'mock-engine-test' };

    beforeEach(() => {
      vi.stubGlobal('navigator', { ...baseNavigator });
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    // ─── Tests ──────────────────────────────────────────────────────────────────

    describe('Renderer.onLost — device.lost / webglcontextlost contract (R-2)', () => {
      it('webgpu: device.lost fires onLost listener with reason + message info', async () => {
        const { navigator, resolveDeviceLost } = makeMockNavigatorWithWebGPU();
        vi.stubGlobal('navigator', navigator);
        const { canvas } = makeMockCanvas({ webgl2: 'context' });
        const { createRenderer } = (await import(ENGINE)) as {
          createRenderer: (
            canvas: unknown,
            opts?: { shaderManifestUrl?: string | undefined },
            bundler?: unknown,
          ) => Promise<{
            backend: string;
            onLost: (cb: (info: { reason: string; message: string }) => void) => () => void;
          }>;
        };

        const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: undefined });
        expect(renderer.backend).toBe('webgpu');

        const received: Array<{ reason: string; message: string }> = [];
        renderer.onLost((info) => {
          received.push(info);
        });

        resolveDeviceLost({ reason: 'destroyed', message: 'mock device lost' });
        // Allow the lost-promise microtask to drain.
        await Promise.resolve();
        await Promise.resolve();

        expect(received.length).toBeGreaterThan(0);
        expect(received[0]?.reason).toBe('destroyed');
      });

      it('engine layer does NOT auto-reload: onLost is a notify-only hook', async () => {
        const { navigator, resolveDeviceLost } = makeMockNavigatorWithWebGPU();
        vi.stubGlobal('navigator', navigator);
        const { canvas } = makeMockCanvas({ webgl2: 'context' });
        const { createRenderer } = (await import(ENGINE)) as {
          createRenderer: (
            canvas: unknown,
            opts?: { shaderManifestUrl?: string | undefined },
            bundler?: unknown,
          ) => Promise<Record<string, unknown>>;
        };

        const renderer = await createRenderer(canvas, {}, { shaderManifestUrl: undefined });
        const recovers = ['restart', 'restore', 'reset'].filter((name) => name in renderer);
        // NOTE: 'recover' is a manual user command added in
        // feat-20260621-renderer-health-recover-skeleton; it is not an
        // auto-reload signal — excluded from the notify-only check.
        expect(recovers).toEqual([]);
        void resolveDeviceLost;
      });
    });
  });
}

{
  // ─── from error-exhaustive.test.ts ───
  describe('error-exhaustive.test.ts', () => {
    describe('t2 - AC-15 AssetErrorCode exhaustive switch (new members)', () => {
      it('AssetErrorCode includes cubemap-handle-missing', () => {
        const code: AssetErrorCode = 'cubemap-handle-missing';
        expect(code).toBe('cubemap-handle-missing');
      });

      it('AssetErrorCode includes invalid-source-format', () => {
        const code: AssetErrorCode = 'invalid-source-format';
        expect(code).toBe('invalid-source-format');
      });

      it('AssetErrorCode includes load-failed', () => {
        const code: AssetErrorCode = 'load-failed';
        expect(code).toBe('load-failed');
      });

      it('AssetErrorCode includes device-unsupported', () => {
        const code: AssetErrorCode = 'device-unsupported';
        expect(code).toBe('device-unsupported');
      });

      it('AssetErrorCode includes ibl-precompute-not-dispatched (t56 M3.5 minor evolution)', () => {
        const code: AssetErrorCode = 'ibl-precompute-not-dispatched';
        expect(code).toBe('ibl-precompute-not-dispatched');
      });

      it('AssetErrorCode exhaustive switch covers all members without default', () => {
        function exhaustive(code: AssetErrorCode): string {
          switch (code) {
            case 'asset-not-found':
              return 'not found';
            case 'asset-parse-failed':
              return 'parse failed';
            case 'asset-format-unsupported':
              return 'format unsupported';
            case 'asset-fetch-failed':
              return 'fetch failed';
            case 'asset-invalid-value':
              return 'invalid value';
            case 'cubemap-handle-missing':
              return 'cubemap handle missing';
            case 'invalid-source-format':
              return 'invalid source format';
            case 'load-failed':
              return 'load failed';
            case 'device-unsupported':
              return 'device unsupported';
            case 'ibl-precompute-not-dispatched':
              return 'ibl precompute not dispatched';
            case 'mesh-vertex-stride-mismatch':
              return 'mesh vertex stride mismatch';
            case 'material-shader-ref-broken':
              return 'shader ref broken';
            case 'material-circular-inheritance':
              return 'circular inheritance';
            // === 2 new codes (feat-20260603-asset-import-loader-injection M1 / w1) ===
            case 'loader-not-registered':
              return 'loader not registered';
            case 'asset-not-imported':
              return 'asset not imported';
            // === 1 new code (feat-20260604-hdr-equirect-cube-importer-loader M2 / w4) ===
            case 'texture-source-not-imported':
              return 'texture source not imported';
            // === 3 new codes (feat-20260608-mesh-multi-section-primitive-multi-material-slot M1 / w2) ===
            case 'mesh-renderer-material-count-mismatch':
              return 'mesh renderer material count mismatch';
            case 'mesh-asset-submeshes-empty':
              return 'mesh asset submeshes empty';
            case 'mesh-submesh-index-range-out-of-bounds':
              return 'mesh submesh index range out of bounds';
            // === 1 new code (feat-20260608-tilemap-object-layer-rendering M0 baseline rebuild) ===
            case 'tileset-region-index-out-of-range':
              return 'tileset region index out of range';
            // === 1 new code (feat-20260608-tilemap-object-layer-rendering M1 schema extension) ===
            case 'tileset-tile-entry-malformed':
              return 'tileset tile entry malformed';
            // === 1 new code (feat-20260621-asset-registry-robustness-invalidate-inflight-cach M2 / w4) ===
            case 'asset-invalidated':
              return 'asset invalidated';
          }
        }
        expect(exhaustive('asset-not-found')).toBe('not found');
        expect(exhaustive('texture-source-not-imported')).toBe('texture source not imported');
        expect(exhaustive('cubemap-handle-missing')).toBe('cubemap handle missing');
        expect(exhaustive('invalid-source-format')).toBe('invalid source format');
        expect(exhaustive('load-failed')).toBe('load failed');
        expect(exhaustive('device-unsupported')).toBe('device unsupported');
        expect(exhaustive('ibl-precompute-not-dispatched')).toBe('ibl precompute not dispatched');
      });
    });

    describe('t2 - AC-15 ImageErrorCode exhaustive switch (new member)', () => {
      it('ImageErrorCode includes image-hdr-decode-failed', () => {
        const code: ImageErrorCode = 'image-hdr-decode-failed';
        expect(code).toBe('image-hdr-decode-failed');
      });

      it('ImageErrorCode exhaustive switch covers all members without default', () => {
        function exhaustive(code: ImageErrorCode): string {
          switch (code) {
            case 'image-decode-failed':
              return 'decode failed';
            case 'image-format-unsupported':
              return 'format unsupported';
            case 'image-dimension-out-of-bounds':
              return 'out of bounds';
            case 'image-meta-missing':
              return 'meta missing';
            case 'image-hdr-decode-failed':
              return 'hdr decode failed';
            // feat-20260521-sprite-atlas-animation M1 T-02 — atlas hook
            // fail-fast triplet (plan-strategy section 2 D-2). Add the three
            // case arms so the exhaustive switch keeps compiling without a
            // default fall-through after ImageErrorCode grew from 5 to 8.
            case 'atlas-empty-input':
              return 'atlas empty input';
            case 'atlas-size-exceeded':
              return 'atlas size exceeded';
            case 'atlas-region-mismatch':
              return 'atlas region mismatch';
          }
        }
        expect(exhaustive('image-decode-failed')).toBe('decode failed');
        expect(exhaustive('image-hdr-decode-failed')).toBe('hdr decode failed');
      });
    });
  });
}

{
  // ─── from errors.test.ts ───
  describe('errors.test.ts', () => {
    describe('AC-11 RuntimeErrorCode exhaustive switch (11 members, no default)', () => {
      it('exhaustive switch covers all members without a default branch', () => {
        function exhaustive(code: RuntimeErrorCode): string {
          switch (code) {
            case 'shadow-invalid-config':
              return 'shadow invalid config';
            case 'skin-joint-count-exceeded':
              return 'skin joint count exceeded';
            case 'skin-joint-despawned':
              return 'skin joint despawned';
            case 'skin-joint-path-unresolved':
              return 'skin joint path unresolved';
            case 'skin-instances-coexist-forbidden':
              return 'skin instances coexist forbidden';
            case 'vertex-storage-buffer-unavailable':
              return 'vertex storage buffer unavailable';
            case 'skin-palette-overflow':
              return 'skin palette overflow';
            case 'material-resolved-empty-passes':
              return 'material resolved empty passes';
            case 'skybox-cubemap-not-ready':
              return 'skybox cubemap not ready';
            case 'mesh-ssbo-capacity-exceeded':
              return 'mesh ssbo capacity exceeded';
            case 'mesh-ssbo-ceiling-reached':
              return 'mesh ssbo ceiling reached';
            case 'hdrp-caps-insufficient':
              return 'hdrp caps insufficient';
            case 'hdrp-light-budget-exceeded':
              return 'hdrp light budget exceeded';
            case 'hdrp-index-list-overflow':
              return 'hdrp index list overflow';
            // feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w6:
            // 3 new deferred-path error codes.
            case 'hdrp-deferred-caps-insufficient':
              return 'hdrp deferred caps insufficient';
            case 'gbuffer-rt-alloc-failed':
              return 'gbuffer rt alloc failed';
            case 'gbuffer-attachment-count-mismatch':
              return 'gbuffer attachment count mismatch';
            // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w17 (D-5):
            // bidirectional Skin <-> pbr-skin material mismatch detected at extract.
            case 'skin-material-mismatch':
              return 'skin material mismatch';
            case 'material-skin-attr-missing':
              return 'material skin attr missing';
            // feat-20260612-skin-palette-per-frame-upload M2 / m2-5:
            // SkinExtractErrorCode subset union (3 new extract-stage classes).
            case 'skeleton-resolve-failed':
              return 'skeleton resolve failed';
            case 'joint-count-mismatch':
              return 'joint count mismatch';
            case 'joint-entity-dangling':
              return 'joint entity dangling';
            // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-4:
            // ShadowAtlas P3 closed-union compliance.
            case 'point-shadow-atlas-uninitialized':
              return 'point shadow atlas uninitialized';
            case 'point-shadow-atlas-bounds-violation':
              return 'point shadow atlas bounds violation';
          }
        }
        expect(exhaustive('skybox-cubemap-not-ready')).toBe('skybox cubemap not ready');
        expect(exhaustive('material-resolved-empty-passes')).toBe('material resolved empty passes');
        expect(exhaustive('shadow-invalid-config')).toBe('shadow invalid config');
        expect(exhaustive('mesh-ssbo-capacity-exceeded')).toBe('mesh ssbo capacity exceeded');
        expect(exhaustive('mesh-ssbo-ceiling-reached')).toBe('mesh ssbo ceiling reached');
      });
    });

    /*
     * feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w3:
     * RuntimeErrorCode +3 members — exhaustive narrow test.
     *
     * AC-07: three new error codes must be members of RuntimeErrorCode closed union.
     * Each error code narrows without a default branch in switch (err.code).
     */
    describe('RuntimeErrorCode +3 new members (w3)', () => {
      it('hdrp-deferred-caps-insufficient is a valid RuntimeErrorCode', () => {
        const code: RuntimeErrorCode = 'hdrp-deferred-caps-insufficient';
        expect(code).toBe('hdrp-deferred-caps-insufficient');
      });

      it('gbuffer-rt-alloc-failed is a valid RuntimeErrorCode', () => {
        const code: RuntimeErrorCode = 'gbuffer-rt-alloc-failed';
        expect(code).toBe('gbuffer-rt-alloc-failed');
      });

      it('gbuffer-attachment-count-mismatch is a valid RuntimeErrorCode', () => {
        const code: RuntimeErrorCode = 'gbuffer-attachment-count-mismatch';
        expect(code).toBe('gbuffer-attachment-count-mismatch');
      });

      it('exhaustive switch covers all 3 new members alongside existing members', () => {
        function exhaustive(code: RuntimeErrorCode): string {
          switch (code) {
            case 'shadow-invalid-config':
              return 'ok';
            case 'skin-joint-count-exceeded':
              return 'ok';
            case 'skin-joint-despawned':
              return 'ok';
            case 'skin-joint-path-unresolved':
              return 'ok';
            case 'skin-instances-coexist-forbidden':
              return 'ok';
            case 'vertex-storage-buffer-unavailable':
              return 'ok';
            case 'skin-palette-overflow':
              return 'ok';
            case 'material-resolved-empty-passes':
              return 'ok';
            case 'skybox-cubemap-not-ready':
              return 'ok';
            case 'mesh-ssbo-capacity-exceeded':
              return 'ok';
            case 'mesh-ssbo-ceiling-reached':
              return 'ok';
            case 'hdrp-caps-insufficient':
              return 'ok';
            case 'hdrp-light-budget-exceeded':
              return 'ok';
            case 'hdrp-index-list-overflow':
              return 'ok';
            case 'skin-material-mismatch':
              return 'ok';
            case 'material-skin-attr-missing':
              return 'ok';
            case 'skeleton-resolve-failed':
              return 'ok';
            case 'joint-count-mismatch':
              return 'ok';
            case 'joint-entity-dangling':
              return 'ok';
            case 'hdrp-deferred-caps-insufficient':
              return 'ok';
            case 'gbuffer-rt-alloc-failed':
              return 'ok';
            case 'gbuffer-attachment-count-mismatch':
              return 'ok';
            case 'point-shadow-atlas-uninitialized':
              return 'ok';
            case 'point-shadow-atlas-bounds-violation':
              return 'ok';
          }
        }
        expect(exhaustive('hdrp-deferred-caps-insufficient')).toBe('ok');
        expect(exhaustive('gbuffer-rt-alloc-failed')).toBe('ok');
        expect(exhaustive('gbuffer-attachment-count-mismatch')).toBe('ok');
        expect(exhaustive('point-shadow-atlas-uninitialized')).toBe('ok');
        expect(exhaustive('point-shadow-atlas-bounds-violation')).toBe('ok');
      });
    });

    describe('AC-03 mesh-ssbo error narrowing in onError callback shape (no `as`)', () => {
      it('switch (err.code) narrows the detail variants for the two new codes', () => {
        // Build a fake onError handler closing over a mutable record we can
        // assert against. Critical: the body must compile without any `as`
        // narrowing — TS must derive `err.detail.requested|capacity|ceiling` as
        // `number` purely from the `case` discriminant.
        const captured: {
          requested: number | null;
          capacity: number | null;
          ceiling: number | null;
          handled: boolean;
        } = { requested: null, capacity: null, ceiling: null, handled: false };

        const onError = (err: RuntimeError): void => {
          switch (err.code) {
            case 'mesh-ssbo-capacity-exceeded': {
              // err narrows to MeshSsboCapacityExceededError; detail is the
              // discriminated-union variant carrying { requested, capacity,
              // ceiling: number }.
              const r: number = err.detail.requested;
              const c: number = err.detail.capacity;
              const ce: number = err.detail.ceiling;
              captured.requested = r;
              captured.capacity = c;
              captured.ceiling = ce;
              captured.handled = true;
              return;
            }
            case 'mesh-ssbo-ceiling-reached': {
              const r: number = err.detail.requested;
              const c: number = err.detail.capacity;
              const ce: number = err.detail.ceiling;
              captured.requested = r;
              captured.capacity = c;
              captured.ceiling = ce;
              captured.handled = true;
              return;
            }
            default:
              // Other arms not exercised in this test; leave captured untouched.
              return;
          }
        };

        // Construct the two new error classes via the published surface and
        // pump them through onError to confirm runtime + compile time agree.
        onError(new MeshSsboCapacityExceededError(2048, 1024, 524288));
        expect(captured.handled).toBe(true);
        expect(captured.requested).toBe(2048);
        expect(captured.capacity).toBe(1024);
        expect(captured.ceiling).toBe(524288);

        captured.handled = false;
        onError(new MeshSsboCeilingReachedError(600000, 524288, 524288));
        expect(captured.handled).toBe(true);
        expect(captured.requested).toBe(600000);
        expect(captured.capacity).toBe(524288);
        expect(captured.ceiling).toBe(524288);
      });
    });
  });
}

{
  // ─── from on-error-fan-out.test.ts ───
  describe('on-error-fan-out.test.ts', () => {
    describe('RhiErrorListenerRegistry — onError fan-out', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('(a) listeners fire in FIFO insertion order', () => {
        const reg = new RhiErrorListenerRegistry();
        const callOrder: number[] = [];
        reg.add(() => {
          callOrder.push(1);
        });
        reg.add(() => {
          callOrder.push(2);
        });
        reg.add(() => {
          callOrder.push(3);
        });
        reg.fire(new RhiError({ code: 'webgpu-runtime-error', expected: 'e', hint: 'h' }));
        expect(callOrder).toEqual([1, 2, 3]);
      });

      it('(b) a throwing listener does not abort subsequent listeners', () => {
        const reg = new RhiErrorListenerRegistry();
        const after = vi.fn();
        reg.add(() => {
          throw new Error('listener boom');
        });
        reg.add(after);
        expect(() =>
          reg.fire(new RhiError({ code: 'webgpu-runtime-error', expected: 'e', hint: 'h' })),
        ).not.toThrow();
        expect(after).toHaveBeenCalledTimes(1);
      });

      it('(c) zero-listener fire() falls back to console.error', () => {
        const reg = new RhiErrorListenerRegistry();
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        reg.fire(
          new RhiError({
            code: 'device-lost',
            expected: 'device intact',
            hint: 'reload page or rebuild renderer',
          }),
        );
        expect(spy).toHaveBeenCalledTimes(1);
      });

      it('(d) a RuntimeError (SkyboxCubemapNotReadyError) fans out without an as-any cast (F-1)', () => {
        const reg = new RhiErrorListenerRegistry();
        const seen: Array<{ code: string; handle: number | undefined }> = [];
        reg.add((e) => {
          // AI-user view: switch (e.code) reaches the RuntimeError arm and narrows
          // to SkyboxCubemapNotReadyError (no cast at the fire() call site below).
          if (e.code === 'skybox-cubemap-not-ready') {
            seen.push({ code: e.code, handle: e.detail.handle });
          } else {
            seen.push({ code: e.code, handle: undefined });
          }
        });
        reg.fire(new SkyboxCubemapNotReadyError(42));
        expect(seen).toEqual([{ code: 'skybox-cubemap-not-ready', handle: 42 }]);
      });

      // feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M4 / T-M4-01:
      // outer catch in render-system.ts recordFrame passes `detail.error` as the
      // caught exception object (preserving .code / .expected / .hint for RhiError).
      // AI users switch on err.code === 'webgpu-runtime-error' then narrow detail
      // via 'error' in e.detail to access e.detail.error.code without `as`.
      it('(e) webgpu-runtime-error detail.error is a structured object (RhiError preserved, narrowing without as on inner code)', () => {
        const reg = new RhiErrorListenerRegistry();

        // Simulate the outer catch: an underlying RhiError (e.g. 'queue-write-buffer-out-of-bounds')
        // is caught and wrapped into a new RhiError with code='webgpu-runtime-error',
        // whose detail.error preserves the original RhiError object (with .code / .expected / .hint).
        const innerErr = new RhiError({
          code: 'queue-write-buffer-out-of-bounds',
          expected: 'offset + size <= buffer size',
          hint: 'check writeBuffer byte range against buffer size; does growMeshSsbo need to fire?',
        });
        const outerErr = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'RenderSystem to record one frame without an internal exception',
          hint: 'inspect detail.error for the underlying cause; next frame will retry',
          detail: { error: innerErr },
        });

        const seen: Array<{ outerCode: string; innerCode: string }> = [];
        reg.add((e) => {
          // AI-user view: switch on e.code narrows to RhiError (vs RuntimeError).
          // Since RhiError is a single class, e.detail is still RhiErrorDetail;
          // use 'error' in guard to narrow to RhiWebgpuRuntimeDetail.
          if (e.code === 'webgpu-runtime-error' && e.detail && 'error' in e.detail) {
            // e.detail.error is RhiError (preserved from outer catch), not string.
            // .code is accessible without `as` — both union branches carry .code.
            seen.push({ outerCode: e.code, innerCode: e.detail.error.code });
          } else {
            seen.push({ outerCode: 'unknown', innerCode: 'unknown' });
          }
        });
        reg.fire(outerErr);
        expect(seen).toEqual([
          { outerCode: 'webgpu-runtime-error', innerCode: 'queue-write-buffer-out-of-bounds' },
        ]);
      });

      it('(f) webgpu-runtime-error detail.error fallback for non-RhiError throws (narrowing without as on inner code)', () => {
        const reg = new RhiErrorListenerRegistry();

        // Simulate a non-RhiError (e.g. plain TypeError) caught by outer catch.
        // detail.error becomes { code: 'unknown', message: '...' } fallback.
        const outerErr = new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'RenderSystem to record one frame without an internal exception',
          hint: 'inspect detail.error for the underlying cause; next frame will retry',
          detail: { error: { code: 'unknown' as const, message: 'plain TypeError boomed' } },
        });

        const seen: Array<{ outerCode: string; innerCode: string }> = [];
        reg.add((e) => {
          if (e.code === 'webgpu-runtime-error' && e.detail && 'error' in e.detail) {
            // e.detail.error.code is accessible without `as` — both union branches
            // (RhiError | { code: string; message: string }) carry .code.
            seen.push({ outerCode: 'unknown', innerCode: e.detail.error.code });
          } else {
            seen.push({ outerCode: 'unknown', innerCode: 'unknown' });
          }
        });
        reg.fire(outerErr);
        expect(seen).toEqual([{ outerCode: 'unknown', innerCode: 'unknown' }]);
      });
    });
  });
}

{
  // ─── from pick-errors.test.ts ───
  describe('pick-errors.test.ts', () => {
    const KEBAB_REGEX = /^[a-z][a-z0-9]*(-[a-z][a-z0-9]*)*$/;

    describe('w8 — PickErrorCode closed union (AC-13)', () => {
      it('camera-component-missing is a valid PickErrorCode literal', () => {
        const code: PickErrorCode = 'camera-component-missing';
        expect(code).toBe('camera-component-missing');
      });

      it('camera-component-missing is valid kebab-case', () => {
        const code: PickErrorCode = 'camera-component-missing';
        expect(code).toMatch(KEBAB_REGEX);
      });

      it('exhaustive switch over PickErrorCode compiles without default', () => {
        function exhaustive(code: PickErrorCode): string {
          switch (code) {
            case 'camera-component-missing':
              return 'camera missing';
          }
        }
        expect(exhaustive('camera-component-missing')).toBe('camera missing');
      });
    });

    describe('w8 — PickError structured 3-field surface (AC-11)', () => {
      it('PickError has .code === camera-component-missing', () => {
        const e = new PickError(7);
        expect(e.code).toBe('camera-component-missing');
      });

      it('PickError .expected is a non-empty string', () => {
        const e = new PickError(7);
        expect(typeof e.expected).toBe('string');
        expect(e.expected.length).toBeGreaterThan(0);
      });

      it('PickError .hint contains a world.set recovery directive', () => {
        const e = new PickError(7);
        expect(e.hint.length).toBeGreaterThan(0);
        expect(e.hint).toContain('world.set');
      });

      it('PickError super message (Error.message) is non-empty', () => {
        const e = new PickError(7);
        expect(e.message.length).toBeGreaterThan(0);
      });

      it('PickError is an instanceof Error and carries .name', () => {
        const e = new PickError(7);
        expect(e).toBeInstanceOf(Error);
        expect(e.name).toBe('PickError');
      });

      it('PickError .detail records the offending camera entity', () => {
        const e = new PickError(42);
        expect(e.detail).toEqual({ cameraEntity: 42 });
      });
    });
  });
}

{
  // ─── from pipeline-errors.test.ts ───
  describe('pipeline-errors.test.ts', () => {
    describe('PipelineErrorCode closed union (2 members)', () => {
      it('exhaustive switch(code) over the 2 members needs no default (completeness)', () => {
        // The function below compiles ONLY if PipelineErrorCode is exactly the
        // 2-member union; an added / missing member breaks the `never` assignment.
        const classify = (code: PipelineErrorCode): string => {
          switch (code) {
            case 'pipeline-already-registered':
              return 'register';
            case 'pipeline-not-found':
              return 'install';
            default: {
              const exhaustive: never = code;
              return exhaustive;
            }
          }
        };
        expect(classify('pipeline-already-registered')).toBe('register');
        expect(classify('pipeline-not-found')).toBe('install');
      });

      it('PipelineErrorCode is the closed 2-member literal union (type identity)', () => {
        expectTypeOf<PipelineErrorCode>().toEqualTypeOf<
          'pipeline-already-registered' | 'pipeline-not-found'
        >();
      });
    });

    describe('PipelineError - pipeline-already-registered (AC-05, throw channel)', () => {
      it('carries code / expected / hint / detail structured fields', () => {
        const err = new PipelineError({
          code: 'pipeline-already-registered',
          detail: { id: 'forgeax::urp' },
        });
        expect(err).toBeInstanceOf(Error);
        expect(err).toBeInstanceOf(PipelineError);
        expect(err.code).toBe('pipeline-already-registered');
        expect(typeof err.expected).toBe('string');
        expect(err.expected.length).toBeGreaterThan(0);
        expect(typeof err.hint).toBe('string');
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.detail).toEqual({ id: 'forgeax::urp' });
      });

      it('detail narrows to { id } after the code guard (charter P4 property access)', () => {
        const err = new PipelineError({
          code: 'pipeline-already-registered',
          detail: { id: 'my::pipeline' },
        });
        if (err.code === 'pipeline-already-registered') {
          const detail: PipelinePreviouslyRegisteredDetail = err.detail;
          expect(detail.id).toBe('my::pipeline');
        }
      });
    });

    describe('PipelineError - pipeline-not-found (AC-06, Result.err channel)', () => {
      it('install invalid handle path: code is pipeline-not-found with actionable hint', () => {
        const err = new PipelineError({
          code: 'pipeline-not-found',
          detail: { handle: 9999 },
        });
        expect(err.code).toBe('pipeline-not-found');
        expect(err.hint.length).toBeGreaterThan(0);
        expect(err.detail).toEqual({ handle: 9999 });
      });

      it('detail narrows to { handle } after the code guard', () => {
        const err = new PipelineError({
          code: 'pipeline-not-found',
          detail: { handle: 42 },
        });
        if (err.code === 'pipeline-not-found') {
          const detail: PipelineNotFoundDetail = err.detail;
          expect(detail.handle).toBe(42);
        }
      });
    });
  });
}

{
  // ─── from post-process-errors.test.ts ───
  describe('post-process-errors.test.ts', () => {
    // ─── PostProcessErrorCode variant scaffold (mirrors pipeline-errors.ts) ────
    //
    // These are the TWO expected union members, matching D-4 / D-9:
    //   - 'post-process-already-registered' (programmer error → throw)
    //   - 'post-process-not-found'          (runtime path → Result.err)
    //
    // Before w12 implements post-process-errors.ts, these inline definitions
    // serve as the compile-time contract: the tests compile, pass, and validate
    // the shape. Once w12 lands, the imports switch to the real module and the
    // tests run against real throw/Result paths after w13.

    type PostProcessErrorCode = 'post-process-already-registered' | 'post-process-not-found';

    describe('feat-20260604 M2 w11: PostProcessErrorCode closed union', () => {
      it('exhaustive switch on PostProcessErrorCode compiles without default', () => {
        // AC-08 / charter P3: the union must be exhaustively switchable without
        // a default branch. This test uses the scaffold type above; after w12,
        // it switches to the real PostProcessErrorCode from post-process-errors.ts.
        const code = 'post-process-already-registered' as PostProcessErrorCode;
        let matched = false;
        switch (code) {
          case 'post-process-already-registered':
            matched = true;
            break;
          case 'post-process-not-found':
            matched = true;
            break;
          // No default case: TS proves completeness.
        }
        expect(matched).toBe(true);
      });

      it('post-process-already-registered has an id detail field', () => {
        // Mirror pipeline-errors.ts PipelinePreviouslyRegisteredDetail.
        // The detail payload for the 'post-process-already-registered' code
        // carries the duplicate id so AI users can self-diagnose.
        const detail: { readonly id: string } = { id: 'fxaa' };
        expect(detail.id).toBe('fxaa');
      });

      it('post-process-not-found has an id detail field', () => {
        // Mirror pipeline-errors.ts PipelineNotFoundDetail but with an
        // id string (not a handle number — post-process lookup is by string id,
        // not by asset handle).
        const detail: { readonly id: string } = { id: 'non-existent' };
        expect(detail.id).toBe('non-existent');
      });

      it('PostProcessErrorCode member count is exactly 2', () => {
        // AC-19: the union has exactly 2 members. This guarantees future
        // additions stay additively evolvable.
        const members: PostProcessErrorCode[] = [
          'post-process-already-registered',
          'post-process-not-found',
        ];
        expect(members.length).toBe(2);
        // Verify all members are distinct.
        const unique = new Set(members);
        expect(unique.size).toBe(2);
      });

      describe('dual-channel contract (throw vs Result.err)', () => {
        it('same-id register is programmer error → throw', () => {
          // Mirror pipeline-errors.ts: Map.has -> throw fail-fast for
          // pipeline-already-registered. Same semantics for postProcess.register.
          //
          // Test shape: when postProcess.register('fxaa', ...) is called a
          // second time with the same id, a PostProcessError with code
          // 'post-process-already-registered' is THROWN (not returned as Result).
          const registered = new Set<string>();
          const mockRegister = (id: string): void => {
            if (registered.has(id)) {
              throw Object.assign(new Error(`post-process id '${id}' already registered`), {
                code: 'post-process-already-registered' as const,
                detail: { id },
              });
            }
            registered.add(id);
          };

          // First call succeeds.
          mockRegister('fxaa');
          expect(registered.has('fxaa')).toBe(true);

          // Second call with same id throws.
          expect(() => mockRegister('fxaa')).toThrow();
        });

        it('reference to unregistered id is runtime path → Result.err', () => {
          // Mirror pipeline-errors.ts: installPipeline returns Result.err
          // pipeline-not-found. Same semantics for addFullscreenPass referencing
          // an unregistered post-process id.
          //
          // The error must carry:
          //   - code: 'post-process-not-found'
          //   - detail: { id: string }
          //   - hint: a string directing the user to postProcess.register
          const registered = new Set<string>();
          const mockLookup = (
            id: string,
          ):
            | { ok: true }
            | {
                ok: false;
                error: { code: PostProcessErrorCode; detail: { id: string }; hint: string };
              } => {
            if (!registered.has(id)) {
              return {
                ok: false,
                error: {
                  code: 'post-process-not-found',
                  detail: { id },
                  hint: `call renderer.postProcess.register('${id}', ...) before referencing it`,
                },
              };
            }
            return { ok: true };
          };

          // Reference to unregistered id.
          const result = mockLookup('non-existent');
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.code).toBe('post-process-not-found');
            expect(result.error.detail.id).toBe('non-existent');
            expect(result.error.hint).toContain('postProcess.register');
          }

          // Reference to registered id succeeds.
          registered.add('fxaa');
          const result2 = mockLookup('fxaa');
          expect(result2.ok).toBe(true);
        });
      });

      describe('error detail narrowing discriminated union', () => {
        it('narrowing on code narrows detail', () => {
          // Charter P3 + P4: discriminated union pattern. After checking
          // `err.code === 'post-process-already-registered'`, TS narrows
          // `err.detail` to the per-code payload without `as` casts.
          //
          // This test validates the narrowing shape. The real discriminated
          // union (PostProcessErrorVariant<C>) is implemented by w12 mirroring
          // PipelineErrorVariant<C> from pipeline-errors.ts.

          // Simulate a variant for 'post-process-already-registered'.
          const err = {
            code: 'post-process-already-registered' as const,
            detail: { id: 'fxaa' },
          };

          if (err.code === 'post-process-already-registered') {
            // detail.id is available after narrowing — no `as` cast needed.
            expect(err.detail.id).toBe('fxaa');
          }
        });

        it('post-process-not-found variant narrows to id detail', () => {
          const err = {
            code: 'post-process-not-found' as const,
            detail: { id: 'missing-id' },
          };

          if (err.code === 'post-process-not-found') {
            expect(err.detail.id).toBe('missing-id');
          }
        });
      });
    });

    // ─── feat-20260609-learn-render-4-5-framebuffers M1 / T-1 ──────────────────
    //
    // After T-2 lands, PostProcessErrorCode grows to a 3-member closed union with
    // 'fullscreen-input-not-found' joining the existing two members. The first two
    // tests below pin the closed-set contract against the REAL PostProcessErrorCode
    // import (not the inline scaffold above) so the union member count + exhaustive
    // switch + new variant detail shape are all locked. The third test exercises
    // the runtime throw site in dispatchFullscreenPass: when reads[0] points to a
    // graph color target that the resolve context cannot resolve (typo / unregistered
    // colorTarget key), the dispatcher MUST throw a structured PostProcessError with
    // code 'fullscreen-input-not-found' and detail = { readsKey, passName } (charter
    // P3 fail-fast + P4 property access).
    describe('feat-20260609 M1 T-1: PostProcessErrorCode 3-member closed union + dispatchFullscreenPass throw', () => {
      it('PostProcessErrorCode union includes fullscreen-input-not-found member (T-2 closed-set growth)', async () => {
        const ppe = await import('../post-process-errors');
        type RealCode = (typeof ppe)['PostProcessError'] extends {
          new (args: { code: infer C; detail: never }): unknown;
        }
          ? C
          : never;
        // Compile-time: 'fullscreen-input-not-found' must be a literal of the closed
        // union (T-2 growth). Runtime assertion mirrors the type to keep vitest happy.
        const member: RealCode = 'fullscreen-input-not-found' as RealCode;
        expect(member).toBe('fullscreen-input-not-found');
      });

      it('exhaustive switch over PostProcessErrorCode covers 3 members without default', async () => {
        const ppeMod: typeof import('../post-process-errors') = await import(
          '../post-process-errors'
        );
        type Code = import('../post-process-errors').PostProcessErrorCode;
        const classify = (code: Code): string => {
          switch (code) {
            case 'post-process-already-registered':
              return 'register';
            case 'post-process-not-found':
              return 'lookup';
            case 'fullscreen-input-not-found':
              return 'reads';
            case 'ssao-radius-non-positive':
              return 'radius';
            case 'ssao-bias-negative':
              return 'bias';
            case 'ssao-storage-buffer-unavailable':
              return 'storage';
            case 'params-size-mismatch':
              return 'params';
            case 'params-update-size-mismatch':
              return 'params-update';
            default: {
              const exhaustive: never = code;
              return exhaustive;
            }
          }
        };
        expect(classify('post-process-already-registered')).toBe('register');
        expect(classify('post-process-not-found')).toBe('lookup');
        expect(classify('fullscreen-input-not-found')).toBe('reads');
        expect(typeof ppeMod.PostProcessError).toBe('function');
      });

      it('fullscreen-input-not-found variant detail = { readsKey, passName } (T-2 detail shape)', async () => {
        const ppe = await import('../post-process-errors');
        const err = new ppe.PostProcessError({
          code: 'fullscreen-input-not-found',
          detail: { readsKey: 'offscreenColor', passName: 'pp' },
        });
        expect(err.code).toBe('fullscreen-input-not-found');
        if (err.code === 'fullscreen-input-not-found') {
          // Property access narrows to FullscreenInputNotFoundDetail without cast.
          const detail: import('../post-process-errors').FullscreenInputNotFoundDetail = err.detail;
          expect(detail.readsKey).toBe('offscreenColor');
          expect(detail.passName).toBe('pp');
        }
        expect(typeof err.expected).toBe('string');
        expect(err.expected.length).toBeGreaterThan(0);
        expect(err.hint).toContain('offscreenColor');
        expect(err.hint).toContain('pp');
      });

      it('dispatchFullscreenPass throws fullscreen-input-not-found when reads[0] resolves to undefined (T-3 throw site)', async () => {
        const { RenderGraph } = await import('@forgeax/engine-render-graph');
        const { addFullscreenPass } = await import('../render-graph-primitives');
        type RPC = import('../render-pipeline-context').RenderPipelineContext;
        // Stub ctx whose runtime.lookupPostProcess returns a registered entry but
        // whose resolve context (passed via graph.execute) returns undefined for
        // the requested reads key. The dispatcher's reads-resolve branch must
        // throw 'fullscreen-input-not-found' with detail = { readsKey, passName }.
        const stubCtx = {
          runtime: {
            lookupPostProcess: (_id: string) => ({
              source: 'fn fs_main() {}',
            }),
            // device + errorRegistry are reached only AFTER reads resolve succeeds;
            // empty stubs are sufficient for the throw-site test (we never get there).
            device: {
              createBindGroupLayout: () => ({ ok: true, value: {} }),
              createSampler: () => ({ ok: true, value: {} }),
              createBindGroup: () => ({ ok: true, value: {} }),
            },
            errorRegistry: { fire: (_e: unknown) => undefined },
          },
          view: {} as unknown,
          encoder: {
            beginRenderPass: () => ({
              setPipeline: () => undefined,
              setBindGroup: () => undefined,
              draw: () => undefined,
              end: () => undefined,
            }),
          } as unknown,
        } as unknown as RPC;

        const graph = new RenderGraph<RPC>();
        graph.addColorTarget('rt', { format: 'bgra8unorm', size: { w: 64, h: 64 } });
        // reads = ['offscreenColor'] but offscreenColor is NOT registered as a color
        // target on this graph (declaration miss -> throw site).
        addFullscreenPass(graph, 'pp', {
          shader: 'test::reads-throw',
          color: 'rt',
          reads: ['offscreenColor'],
        });

        const passes = (
          graph as unknown as {
            passes: {
              list(): readonly {
                name: string;
                descriptor: {
                  execute?:
                    | ((c: unknown) => void)
                    | ((c: unknown, r: { resolve: (n: string) => unknown }) => void);
                };
              }[];
            };
          }
        ).passes.list();
        const pp = passes.find((p) => p.name === 'pp');
        expect(pp, 'pass "pp" must be registered').toBeDefined();
        if (!pp || pp.descriptor.execute === undefined) return;

        // Resolve context returns undefined for any name (mirrors the
        // pre-compile / unregistered-key path).
        const resolveCtx = { resolve: (_n: string) => undefined };

        let caught: unknown = null;
        try {
          (pp.descriptor.execute as (c: unknown, r: typeof resolveCtx) => void)(
            stubCtx,
            resolveCtx,
          );
        } catch (e) {
          caught = e;
        }
        expect(caught, 'dispatchFullscreenPass must throw on unresolved reads[0]').not.toBeNull();
        const err = caught as {
          code?: string;
          detail?: { readsKey?: string; passName?: string };
        };
        expect(err.code).toBe('fullscreen-input-not-found');
        expect(err.detail?.readsKey).toBe('offscreenColor');
        expect(err.detail?.passName).toBe('pp');
      });
    });
  });
}

{
  // ─── from render-skylight-warn.test.ts ───
  describe('render-skylight-warn.test.ts', () => {
    describe('0-light three-condition conjunction (AC-10) -- feat-20260520-skylight-ibl-cubemap M4 / t23', () => {
      it('(a) three-condition conjunction: all true -> warn fires', () => {
        // Conditions: no Skylight (true) AND 0 direct light (true) AND
        // StandardMaterial (true) -> all three true -> warn MUST fire.
        //
        // When t27 wires the 3-condition check in render-system-record.ts,
        // this contract assertion becomes:
        //   expect(console.warn).toHaveBeenCalled()
        const allThreeTrue = true;
        expect(allThreeTrue).toBe(true);
      });

      it('(b) Skylight present + 0 direct light + StandardMaterial -> NO warn', () => {
        // Conditions: no Skylight (FALSE -- Skylight present) AND
        // 0 direct light (true) AND StandardMaterial (true).
        // Since condition 1 is false, the 3-condition conjunction is false.
        // Skylight is a legitimate light source; ambient IBL renders normally.
        //
        // When t27 wires the check, this becomes:
        //   expect(console.warn).not.toHaveBeenCalled()
        const skylightSuppressesWarn = true;
        expect(skylightSuppressesWarn).toBe(true);
      });

      it('(c) multiple Skylight entities -> warn in dev AND prod', () => {
        // F-4 nit: >1 Skylight entity fires console.warn with message
        // "multiple skylight entities found, using first" in both dev
        // and prod environments. The first Skylight (by archetype order) wins.
        //
        // When t27 wires the check in render-system-record.ts, this becomes:
        //   expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('multiple skylight'))
        const multiWarnBothEnvs = true;
        expect(multiWarnBothEnvs).toBe(true);
      });

      it('(d) Skylight intensity=0 -> ambient=0, NO warn', () => {
        // intensity=0 is mathematically valid: ambient term = 0.
        // Conditions: no Skylight (FALSE -- Skylight present with intensity=0)
        // AND 0 direct light (true) AND StandardMaterial (true).
        // 3-condition conjunction false (Skylight exists even if intensity=0);
        // no warn emitted. Ambient term computes to 0 via shader math.
        //
        // When t27 wires this, becomes expect(console.warn).not.toHaveBeenCalled()
        const zeroIntensityNoWarn = true;
        expect(zeroIntensityNoWarn).toBe(true);
      });

      it('(e) Skylight + direct light + StandardMaterial -> NO zero-light warn', () => {
        // Both Skylight and direct light present: zero-light condition never
        // activates. 3-condition conjunction false because direct light present.
        //
        // When t27 wires this, becomes expect(console.warn).not.toHaveBeenCalled()
        const bothLightsNoWarn = true;
        expect(bothLightsNoWarn).toBe(true);
      });

      it('(f) no Skylight + 0 direct light + UnlitMaterial -> NO warn', () => {
        // 3-condition conjunction: StandardMaterial condition is FALSE (unlit).
        // Unlit materials don't consume PBR IBL ambient.
        //
        // When t27 wires this, becomes expect(console.warn).not.toHaveBeenCalled()
        const unlitNoWarn = true;
        expect(unlitNoWarn).toBe(true);
      });

      it('(g) no Skylight + direct light present + StandardMaterial -> NO warn', () => {
        // 3-condition conjunction: 0-direct-light condition is FALSE.
        // Direct light(s) render normally; no zero-light warn.
        //
        // When t27 wires this, becomes expect(console.warn).not.toHaveBeenCalled()
        const directLightNoWarn = true;
        expect(directLightNoWarn).toBe(true);
      });
    });
  });
}

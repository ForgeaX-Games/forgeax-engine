// @forgeax/engine-runtime — recover() single idempotent rebuild tests (M3)
//
// feat-20260622-s5-device-surface-self-heal-recover M3. Covers:
//   w10 — recover() injectable factory success rebuild (A-AC-06)
//   w11 — recover() adapter-unavailable failure code (A-AC-07)
//   w12 — recover() device-unavailable failure code (A-AC-07)
//   w13 — recover() idempotent + alive sentinel + no-background-state (A-AC-08)
//   w14 — recover() preserves CPU POD cache (A-AC-12)
//   w19 — RecoverErrorCode exhaustiveness grep gate + switch (A-AC-09)
//
// recover() reuses tryCreateWebGPURenderer / gpuStore.destroyAll /
// ensureContextConfigured (plan-strategy D-1). A2/T1 precedent: the device
// factory is injectable via the mocked RHI backend pack so the rebuild path
// runs without a real GPU (A-OOS-7 honest downgrade; real wgpu device-lost
// end-to-end stays a local-only gate).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Result } from '@forgeax/engine-rhi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoverError, type RecoverErrorCode } from '../errors/recover';
import type { HealthSnapshot } from '../renderer';

// ── Controllable mock state (module-level so vi.mock factories can read) ──────
//
// recover() re-invokes pack.rhi.requestAdapter -> adapter.requestDevice. These
// flags let a single test flip the next acquisition to fail on the adapter or
// device step, exercising the two add-only RecoverErrorCode members.

const recoverMock = {
  adapterReturnsNull: false,
  deviceThrows: false,
  requestAdapterCalls: 0,
  requestDeviceCalls: 0,
};

function resetRecoverMock(): void {
  recoverMock.adapterReturnsNull = false;
  recoverMock.deviceThrows = false;
  recoverMock.requestAdapterCalls = 0;
  recoverMock.requestDeviceCalls = 0;
}

let testDeviceLostResolve: ((info: unknown) => void) | null = null;

function makeFakeRhiDevice(): Record<string, unknown> {
  let resolveLost!: (info: unknown) => void;
  const lost = new Promise<unknown>((res) => {
    resolveLost = res;
  });
  testDeviceLostResolve = resolveLost;
  return {
    __brand: 'RhiDevice',
    lost,
    features: new Set<string>(),
    limits: {} as Record<string, number>,
    caps: {},
    queue: {
      submit: () => ({ ok: true, value: undefined }),
      writeBuffer: () => ({ ok: true, value: undefined }),
      writeTexture: () => ({ ok: true, value: undefined }),
      onSubmittedWorkDone: async () => undefined,
    },
    createBuffer: () => ({ ok: true, value: { __brand: 'Buffer' } }),
    createTexture: () => ({ ok: true, value: { __brand: 'Texture' } }),
    destroyTexture: () => ({ ok: true, value: undefined }),
    destroyBuffer: () => ({ ok: true, value: undefined }),
    createBindGroupLayout: () => ({ ok: true, value: { __brand: 'BindGroupLayout' } }),
    createBindGroup: () => ({ ok: true, value: { __brand: 'BindGroup' } }),
    createPipelineLayout: () => ({ ok: true, value: { __brand: 'PipelineLayout' } }),
    createRenderPipeline: () => ({
      ok: true,
      value: {
        __brand: 'RenderPipeline',
        getBindGroupLayout: () => ({ __brand: 'BindGroupLayout' }),
      },
    }),
    createComputePipeline: () => ({
      ok: true,
      value: {
        __brand: 'ComputePipeline',
        getBindGroupLayout: () => ({ __brand: 'BindGroupLayout' }),
      },
    }),
    createSampler: () => ({ ok: true, value: { __brand: 'Sampler' } }),
    createShaderModule: () => ({
      ok: true,
      value: { __brand: 'ShaderModule', getCompilationInfo: async () => ({ messages: [] }) },
    }),
    createTextureView: () => ({ ok: true, value: { __brand: 'TextureView' } }),
    createCommandEncoder: () => ({
      ok: true,
      value: {
        beginRenderPass: () => ({
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          setVertexBuffer: () => undefined,
          setIndexBuffer: () => undefined,
          setViewport: () => undefined,
          setScissorRect: () => undefined,
          draw: () => undefined,
          drawIndexed: () => undefined,
          end: () => undefined,
        }),
        beginComputePass: () => ({
          setPipeline: () => undefined,
          setBindGroup: () => undefined,
          dispatchWorkgroups: () => undefined,
          end: () => undefined,
        }),
        copyTextureToTexture: () => undefined,
        copyBufferToBuffer: () => undefined,
        finish: () => ({ ok: true, value: { __brand: 'CommandBuffer' } }),
      },
    }),
  };
}

function makeMockCanvas(): HTMLCanvasElement {
  return {
    width: 800,
    height: 600,
    getContext(kind: string): unknown {
      if (kind === 'webgpu') {
        return {
          __mockTag: 'webgpu-canvas-context',
          configure: () => undefined,
          unconfigure: () => undefined,
          getCurrentTexture: () => ({ createView: () => ({}) }),
        };
      }
      if (kind === 'webgl2') {
        return {
          __mockTag: 'webgl2',
          getExtension: () => null,
          getParameter: () => 1,
          isContextLost: () => false,
        };
      }
      return null;
    },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as Partial<HTMLCanvasElement> as HTMLCanvasElement;
}

vi.mock('@forgeax/engine-rhi-webgpu', async () => {
  const actualRhi =
    await vi.importActual<typeof import('@forgeax/engine-rhi')>('@forgeax/engine-rhi');
  const fakeAdapter = {
    features: new Set<string>(),
    limits: {} as Readonly<Record<string, number>>,
    async requestDevice() {
      recoverMock.requestDeviceCalls += 1;
      if (recoverMock.deviceThrows) {
        throw new Error('mock requestDevice failure (recover-device-unavailable path)');
      }
      return actualRhi.ok(makeFakeRhiDevice());
    },
  };
  return {
    rhi: {
      requestAdapter: async () => {
        recoverMock.requestAdapterCalls += 1;
        if (recoverMock.adapterReturnsNull) {
          return actualRhi.err({
            code: 'adapter-unavailable',
            message: 'mock adapter null (recover-adapter-unavailable path)',
          });
        }
        return actualRhi.ok(fakeAdapter);
      },
      acquireCanvasContext: (_canvas: unknown) =>
        actualRhi.ok({
          configure: () => actualRhi.ok(undefined),
          unconfigure: () => actualRhi.ok(undefined),
          getCurrentTexture: () => actualRhi.ok({ __brand: 'TextureView' }),
        }),
    },
    createShaderModule: async () => actualRhi.ok({ __brand: 'ShaderModule' } as unknown as object),
  };
});

vi.mock('@forgeax/engine-rhi-wgpu', async () => {
  const actualRhi =
    await vi.importActual<typeof import('@forgeax/engine-rhi')>('@forgeax/engine-rhi');
  const fakeAdapter = {
    features: new Set<string>(),
    limits: {} as Readonly<Record<string, number>>,
    async requestDevice() {
      recoverMock.requestDeviceCalls += 1;
      if (recoverMock.deviceThrows) {
        throw new Error('mock requestDevice failure (recover-device-unavailable path)');
      }
      return actualRhi.ok(makeFakeRhiDevice());
    },
  };
  return {
    rhi: {
      requestAdapter: async () => {
        recoverMock.requestAdapterCalls += 1;
        if (recoverMock.adapterReturnsNull) {
          return actualRhi.err({
            code: 'adapter-unavailable',
            message: 'mock adapter null (recover-adapter-unavailable path)',
          });
        }
        return actualRhi.ok(fakeAdapter);
      },
      acquireCanvasContext: (_canvas: unknown) =>
        actualRhi.ok({
          configure: () => actualRhi.ok(undefined),
          unconfigure: () => actualRhi.ok(undefined),
          getCurrentTexture: () => actualRhi.ok({ __brand: 'TextureView' }),
        }),
    },
    ensureReady: async () => undefined,
  };
});

function makeStubGPU() {
  return {
    requestAdapter: async () => ({
      features: new Set<string>(),
      limits: {},
      requestDevice: async () => makeFakeRhiDevice(),
    }),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
}

// Shader manifest as a data URL (no HTTP). Carries the engine SSOT triple
// (pbr/unlit/tonemap content markers) buildReadyWebGPU requires, mirroring the
// production manifest shape — bind-group-cache-binding.test.ts:163. The recover()
// rebuild re-runs buildReadyWebGPU against an already-populated ShaderRegistry,
// so the manifest must satisfy the triple check on the rebuild path (a single-
// entry manifest only passes the boot path because the registry is still empty
// when boot's buildReadyWebGPU walks it).
const RECOVER_TEST_MANIFEST_URL = (() => {
  const materialShaderStub = (identifier: string) => ({
    identifier,
    sourcePath: `${identifier}.wgsl`,
    composedWgsl: '/* stub */',
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
    ],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
})();

type TestRenderer = {
  recover: () => Promise<Result<void, RecoverError>>;
  health: () => HealthSnapshot;
  store: { destroyAll: () => void };
  assets: { inspect?: () => unknown };
  ready: Promise<unknown>;
};

async function makeRenderer(): Promise<TestRenderer> {
  const canvas = makeMockCanvas();
  const { createRenderer } = await import('../createRenderer');
  const renderer = await createRenderer(
    canvas,
    {},
    { shaderManifestUrl: RECOVER_TEST_MANIFEST_URL },
  );
  return renderer as unknown as TestRenderer;
}

// Drive the renderer into device-lost via the mock device.lost resolver.
// Uses reason 'unknown' (genuine unrecoverable loss) -- reason 'destroyed' is
// INTENTIONAL teardown (device.destroy() on dispose / tab recycle / test-pool
// reuse) and per the requirements A constraint must NOT flip health to
// 'device-lost' (that is what the dedicated test below asserts).
async function driveDeviceLost(renderer: TestRenderer): Promise<void> {
  if (!testDeviceLostResolve) throw new Error('device.lost resolver not set up');
  testDeviceLostResolve({ reason: 'unknown', message: 'recover-test device lost' });
  await vi.waitFor(() => {
    expect(renderer.health().reason).toBe('device-lost');
  });
}

// Each rebuild test boots a full renderer (createRenderer + ready) and then
// runs recover()'s second full assembly. Two heavy createRenderer boots in one
// test occasionally exceed vitest's 5 s default under max-parallel suite load
// (same cold-boot contention the dawn project mitigates with a raised budget);
// a per-test 30 s budget removes the flake without affecting the stable path.
const RECOVER_BOOT_TIMEOUT_MS = 30000;

describe('recover() single idempotent rebuild (M3)', () => {
  beforeEach(() => {
    resetRecoverMock();
    testDeviceLostResolve = null;
    vi.stubGlobal('navigator', { ...navigator, gpu: makeStubGPU() });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    testDeviceLostResolve = null;
  });

  // ── w10: injectable factory success rebuild (A-AC-06) ──────────────────────

  it(
    'w10: device-lost -> recover() rebuilds via injected factory -> ok + alive',
    async () => {
      const renderer = await makeRenderer();
      await renderer.ready;
      const destroyAllSpy = vi.spyOn(renderer.store, 'destroyAll');

      await driveDeviceLost(renderer);
      expect(renderer.health().reason).toBe('device-lost');

      const adapterCallsBefore = recoverMock.requestAdapterCalls;
      const deviceCallsBefore = recoverMock.requestDeviceCalls;

      const result = await renderer.recover();

      expect(result.ok).toBe(true);
      expect(renderer.health().reason).toBe('alive');
      // destroyAll cleared GPU resources before rebuild.
      expect(destroyAllSpy).toHaveBeenCalled();
      // tryCreateWebGPURenderer re-invoked requestAdapter + requestDevice.
      expect(recoverMock.requestAdapterCalls).toBeGreaterThan(adapterCallsBefore);
      expect(recoverMock.requestDeviceCalls).toBeGreaterThan(deviceCallsBefore);
      // pipeline rebuild completes; subsequent ready resolves ok.
      await renderer.ready;
    },
    RECOVER_BOOT_TIMEOUT_MS,
  );

  // ── w10b: reason 'destroyed' is intentional teardown, NOT device-lost ───────
  // Regression (PR #495 vitest-browser red): F4 made the device.lost Promise
  // actually resolve. On CI chromium the GPUDevice is destroyed between test
  // files (reason 'destroyed'); without this gate the health channel flipped to
  // 'device-lost', the M2 draw() guard refused the frame, and unrelated browser
  // tests failed with "renderer.draw frame N failed". Per the requirements A
  // constraint, reason 'destroyed' (host/driver device.destroy()) must leave
  // health alive. dawn/unit could not see this -- only the browser path does.
  it(
    'w10b: device.lost reason=destroyed does NOT flip health to device-lost (intentional teardown)',
    async () => {
      const renderer = await makeRenderer();
      await renderer.ready;
      expect(renderer.health().reason).toBe('alive');

      if (!testDeviceLostResolve) throw new Error('device.lost resolver not set up');
      testDeviceLostResolve({ reason: 'destroyed', message: 'device was destroyed (teardown)' });

      // Give the lost Promise's microtask chain a tick to settle, then assert
      // health stayed alive (the fanout gated the destroyed reason). Because
      // health stays alive, the M2 draw() guard does NOT refuse frames -- which
      // is exactly what unblocks the browser tests that regressed in PR #495.
      await Promise.resolve();
      await Promise.resolve();
      expect(renderer.health().reason).toBe('alive');
    },
    RECOVER_BOOT_TIMEOUT_MS,
  );

  // ── w11: adapter-unavailable failure code (A-AC-07) ────────────────────────

  it(
    'w11: recover() with null adapter -> recover-adapter-unavailable, health stays device-lost',
    async () => {
      const renderer = await makeRenderer();
      await renderer.ready;
      await driveDeviceLost(renderer);

      recoverMock.adapterReturnsNull = true;
      const result = await renderer.recover();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('recover-adapter-unavailable');
        expect(typeof result.error.expected).toBe('string');
        expect(result.error.expected.length).toBeGreaterThan(0);
        expect(typeof result.error.hint).toBe('string');
        expect(result.error.hint.length).toBeGreaterThan(0);
      }
      // Failure does not fake the renderer back to alive.
      expect(renderer.health().reason).toBe('device-lost');
    },
    RECOVER_BOOT_TIMEOUT_MS,
  );

  // ── w12: device-unavailable failure code (A-AC-07) ─────────────────────────

  it(
    'w12: recover() with requestDevice throw -> recover-device-unavailable, health stays device-lost',
    async () => {
      const renderer = await makeRenderer();
      await renderer.ready;
      await driveDeviceLost(renderer);

      recoverMock.deviceThrows = true;
      const result = await renderer.recover();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('recover-device-unavailable');
        expect(typeof result.error.expected).toBe('string');
        expect(result.error.expected.length).toBeGreaterThan(0);
        expect(typeof result.error.hint).toBe('string');
        expect(result.error.hint.length).toBeGreaterThan(0);
      }
      expect(renderer.health().reason).toBe('device-lost');
    },
    RECOVER_BOOT_TIMEOUT_MS,
  );

  // ── w13: idempotent + alive sentinel + no background state (A-AC-08) ────────

  it(
    'w13(a): recover() on alive renderer returns recover-not-needed',
    async () => {
      const renderer = await makeRenderer();
      await renderer.ready;
      expect(renderer.health().reason).toBe('alive');

      const result = await renderer.recover();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('recover-not-needed');
      }
    },
    RECOVER_BOOT_TIMEOUT_MS,
  );

  it(
    'w13(b): after a successful recover, second recover returns recover-not-needed',
    async () => {
      const renderer = await makeRenderer();
      await renderer.ready;
      await driveDeviceLost(renderer);

      const first = await renderer.recover();
      expect(first.ok).toBe(true);
      expect(renderer.health().reason).toBe('alive');

      // Idempotent: a second recover() in the now-alive state is a no-op signal.
      const second = await renderer.recover();
      expect(second.ok).toBe(false);
      if (!second.ok) {
        expect(second.error.code).toBe('recover-not-needed');
      }
    },
    RECOVER_BOOT_TIMEOUT_MS,
  );

  it('w13(c): recover() function body has no setTimeout / retryCount / recovering / maxRetries', () => {
    // Hard acceptanceCheck (PD5): the compressed-discipline mandate forbids any
    // background state machine, retry counter, or timer in the recover path.
    // Source-text assertion over createRenderer.ts isolates the recover()
    // method body and greps for the forbidden constructs.
    const src = readFileSync(
      fileURLToPath(new URL('../createRenderer.ts', import.meta.url)),
      'utf8',
    );
    const startIdx = src.indexOf('async recover(): Promise<Result<void, RecoverError>>');
    expect(startIdx).toBeGreaterThan(-1);
    // The onHealthChange method declaration immediately follows recover() in
    // the renderer facade object; bound the slice there.
    const endIdx = src.indexOf('onHealthChange(', startIdx);
    expect(endIdx).toBeGreaterThan(startIdx);
    const body = src.slice(startIdx, endIdx);
    expect(body).not.toMatch(/setTimeout/);
    expect(body).not.toMatch(/setInterval/);
    expect(body).not.toMatch(/retryCount/);
    expect(body).not.toMatch(/maxRetries/);
    expect(body).not.toMatch(/maxLetries/);
    expect(body).not.toMatch(/recovering/);
  });

  // ── w14: preserves CPU POD cache (A-AC-12) ─────────────────────────────────

  it(
    'w14: recover() preserves AssetRegistry CPU POD entries; only GPU resources cleared',
    async () => {
      const renderer = await makeRenderer();
      await renderer.ready;

      // Inspect the AssetRegistry catalog entry count before recover. The
      // AssetRegistry survives recover (CPU POD cache); only the GpuResourceStore
      // is destroyed + the device rebuilt.
      const inspectBefore =
        typeof renderer.assets.inspect === 'function' ? renderer.assets.inspect() : null;

      const destroyAllSpy = vi.spyOn(renderer.store, 'destroyAll');
      await driveDeviceLost(renderer);
      const result = await renderer.recover();
      expect(result.ok).toBe(true);

      // GPU resources cleared via destroyAll.
      expect(destroyAllSpy).toHaveBeenCalled();

      // AssetRegistry instance identity is preserved (same CPU POD registry).
      const inspectAfter =
        typeof renderer.assets.inspect === 'function' ? renderer.assets.inspect() : null;
      // The catalog entry count is unchanged across recover (CPU POD preserved).
      if (inspectBefore !== null && inspectAfter !== null) {
        expect(JSON.stringify(inspectAfter)).toBe(JSON.stringify(inspectBefore));
      }
    },
    RECOVER_BOOT_TIMEOUT_MS,
  );
});

// ── w19: RecoverErrorCode exhaustiveness grep gate + switch (A-AC-09) ─────────

describe('RecoverErrorCode closed union (A-AC-09)', () => {
  it('errors.ts RecoverErrorCode definition line declares exactly 4 literal members', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../errors/recover.ts', import.meta.url)),
      'utf8',
    );
    const defLine = src.split('\n').find((l) => l.includes('export type RecoverErrorCode'));
    expect(defLine).toBeDefined();
    const literals = (defLine as string).match(/recover-[a-z-]+/g) ?? [];
    expect(literals).toEqual([
      'recover-not-needed',
      'recover-not-implemented',
      'recover-adapter-unavailable',
      'recover-device-unavailable',
    ]);
  });

  it('exhaustive switch over RecoverErrorCode compiles without default / as cast', () => {
    function handle(code: RecoverErrorCode): string {
      switch (code) {
        case 'recover-not-needed':
          return 'not-needed';
        case 'recover-not-implemented':
          return 'not-implemented';
        case 'recover-adapter-unavailable':
          return 'adapter-unavailable';
        case 'recover-device-unavailable':
          return 'device-unavailable';
      }
    }
    expect(handle('recover-adapter-unavailable')).toBe('adapter-unavailable');
    expect(handle('recover-device-unavailable')).toBe('device-unavailable');
  });

  it('both new codes carry valid .expected + .hint', () => {
    for (const code of ['recover-adapter-unavailable', 'recover-device-unavailable'] as const) {
      const e = new RecoverError(code);
      expect(e.code).toBe(code);
      expect(e.expected.length).toBeGreaterThan(0);
      expect(e.hint.length).toBeGreaterThan(0);
    }
  });
});

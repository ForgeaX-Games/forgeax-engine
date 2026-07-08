// @forgeax/engine-runtime — renderer health / recover unit + integration tests
//
// Covers:
//   w1 — HealthReason narrowing + detail discriminated union test (AC-05)
//   w2 — RecoverError union exhaustiveness test (AC-06)
//   w3 — HealthListenerRegistry replay + unsubscribe + isolation test (AC-07/AC-08)
//   w4 — HealthSnapshot shape + recoverable derivation + immutability test (AC-02)
//   w8 — health() healthy-state baseline integration test
//   w9 — recover() healthy-state returns recover-not-needed test (AC-04)
//   w10 — recover() degraded-state placeholder + health unchanged test (AC-04b)
//
// w1-w4: unit tests (types + registry, GREEN after M1 w5-w7)
// w8-w10: integration tests (createRenderer + mock RHI, RED until w11-w13)

import type { Result } from '@forgeax/engine-rhi';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecoverError, type RecoverErrorCode } from '../errors/recover';
import {
  deriveRecoverable,
  type HealthChangeListener,
  HealthListenerRegistry,
  type HealthReason,
  type HealthSnapshot,
} from '../renderer';

// ── w1: HealthReason narrowing + detail discriminated union (AC-05) ─────────

describe('HealthReason narrowing (AC-05)', () => {
  it('switch(snap.reason) narrows detail per reason without as casts', () => {
    // Consumer-side switch exercising all 3 HealthReason members.
    // TS must narrow snap.detail in each case branch — zero `as` casts.
    function consumeHealth(snap: HealthSnapshot): string {
      switch (snap.reason) {
        case 'alive':
          // alive variant has no detail field — zero as casts
          return 'alive';
        case 'device-lost':
          // detail narrows to HealthDetailDeviceLost; lostReason scoped to this variant
          return `device-lost(lostReason=${snap.detail.lostReason}): ${snap.detail.message}`;
        case 'internal-fault':
          // detail narrows to HealthDetailInternalFault; message is the only field
          return `internal-fault: ${snap.detail.message}`;
      }
    }
    // Compile-time assertion: the function compiles with zero `as` casts
    expect(typeof consumeHealth).toBe('function');
  });

  it('HealthReason has exactly 3 members — exhaustiveness without default', () => {
    // If TS compiles this switch without default, the union is exactly 3 members.
    function exhaustive(reason: HealthReason): string {
      switch (reason) {
        case 'alive':
          return 'alive';
        case 'device-lost':
          return 'device-lost';
        case 'internal-fault':
          return 'internal-fault';
      }
    }
    expect(typeof exhaustive).toBe('function');
  });
});

// ── w2: RecoverError union exhaustiveness (AC-06) ──────────────────────────

describe('RecoverError closed union (AC-06)', () => {
  it('switch(err.code) exhaustively matches all members without default', () => {
    // Consumer-side switch matching every RecoverErrorCode member.
    // TS must not emit non-exhaustive errors; no `default` branch.
    // feat-20260622-s5 M3 / w19: union grew add-only to 4 members (adapter /
    // device unavailable join the S3 not-needed / not-implemented(reserved)).
    function handleRecover(err: RecoverError): string {
      switch (err.code) {
        case 'recover-not-needed':
          return `not-needed: ${err.hint}`;
        case 'recover-not-implemented':
          return `not-implemented: ${err.hint}`;
        case 'recover-adapter-unavailable':
          return `adapter-unavailable: ${err.hint}`;
        case 'recover-device-unavailable':
          return `device-unavailable: ${err.hint}`;
      }
    }
    expect(typeof handleRecover).toBe('function');
  });

  it('RecoverErrorCode has exactly 4 members', () => {
    function exhaustive(code: RecoverErrorCode): string {
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
    expect(typeof exhaustive).toBe('function');
  });

  it('RecoverError carries .code, .expected, .hint fields', () => {
    const err = new RecoverError('recover-not-needed');
    expect(err.code).toBe('recover-not-needed');
    expect(typeof err.expected).toBe('string');
    expect(err.expected.length).toBeGreaterThan(0);
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
  });

  it('recover-not-implemented code also carries valid .expected + .hint', () => {
    const err = new RecoverError('recover-not-implemented');
    expect(err.code).toBe('recover-not-implemented');
    expect(typeof err.expected).toBe('string');
    expect(err.expected.length).toBeGreaterThan(0);
    expect(typeof err.hint).toBe('string');
    expect(err.hint.length).toBeGreaterThan(0);
  });
});

// ── w3: HealthListenerRegistry replay + unsubscribe + isolation (AC-07/AC-08)

describe('HealthListenerRegistry (AC-07/AC-08)', () => {
  it('late-attach replay: fire then add calls listener immediately', () => {
    const registry = new HealthListenerRegistry();
    const snapshot: HealthSnapshot = {
      reason: 'device-lost',
      detail: { lostReason: 'destroyed', message: 'test device lost' },
      recoverable: true,
    };
    registry.fire(snapshot);

    const cb = vi.fn<HealthChangeListener>();
    registry.add(cb);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(snapshot);
  });

  it('unsubscribe: add returns unsubscribe, listener not called after', () => {
    const registry = new HealthListenerRegistry();
    const cb = vi.fn<HealthChangeListener>();
    const unsubscribe = registry.add(cb);

    // Unsubscribe
    unsubscribe();

    // Fire after unsubscribe — cb must not be called
    const snapshot: HealthSnapshot = {
      reason: 'alive',
      recoverable: false,
    };
    registry.fire(snapshot);

    expect(cb).not.toHaveBeenCalled();
  });

  it('listener-throw isolation: first throws, second still fires', () => {
    const registry = new HealthListenerRegistry();

    const cb1 = vi.fn<HealthChangeListener>(() => {
      throw new Error('cb1 intentional throw');
    });
    const cb2 = vi.fn<HealthChangeListener>();

    registry.add(cb1);
    registry.add(cb2);

    // Suppress console.error from the try/catch isolation
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const snapshot: HealthSnapshot = {
      reason: 'internal-fault',
      detail: { message: 'simulated fault' },
      recoverable: false,
    };
    registry.fire(snapshot);

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledWith(snapshot);
    // cb1's throw should be caught and surfaced via console.error
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('clear detaches all listeners but preserves fired/lastSnapshot for replay', () => {
    const registry = new HealthListenerRegistry();

    const snapshot: HealthSnapshot = {
      reason: 'device-lost',
      detail: { lostReason: 'unknown', message: 'test' },
      recoverable: true,
    };
    registry.fire(snapshot);

    registry.clear();

    // Late-attach after clear: fired/lastSnapshot preserved, so replay still works
    const cb = vi.fn<HealthChangeListener>();
    registry.add(cb);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(snapshot);
  });

  it('getLastSnapshot returns alive baseline when never fired', () => {
    const registry = new HealthListenerRegistry();
    const snapshot = registry.getLastSnapshot();

    expect(snapshot.reason).toBe('alive');
    expect(snapshot.recoverable).toBe(false);
  });

  it('getLastSnapshot returns last fired snapshot after fire', () => {
    const registry = new HealthListenerRegistry();
    const fired: HealthSnapshot = {
      reason: 'device-lost',
      detail: { lostReason: 'destroyed', message: 'lost' },
      recoverable: true,
    };
    registry.fire(fired);

    const snapshot = registry.getLastSnapshot();
    expect(snapshot.reason).toBe('device-lost');
    expect(snapshot.recoverable).toBe(true);
    if (snapshot.reason === 'device-lost') {
      expect(snapshot.detail).toEqual({ lostReason: 'destroyed', message: 'lost' });
    }
  });
});

// ── w4: HealthSnapshot shape + recoverable derivation + immutability (AC-02) ─

describe('HealthSnapshot shape + recoverable derivation (AC-02)', () => {
  it('deriveRecoverable: alive -> false', () => {
    expect(deriveRecoverable('alive')).toBe(false);
  });

  it('deriveRecoverable: device-lost -> true', () => {
    expect(deriveRecoverable('device-lost')).toBe(true);
  });

  it('deriveRecoverable: internal-fault -> false', () => {
    expect(deriveRecoverable('internal-fault')).toBe(false);
  });

  it('HealthSnapshot has exactly { reason, detail?, recoverable } fields', () => {
    // Shape assertion: discriminated union — alive has no detail, degraded
    // variants have required detail. TS would error on mismatched shapes.
    const snapAlive: HealthSnapshot = { reason: 'alive', recoverable: false };
    expect(snapAlive.reason).toBe('alive');
    expect(snapAlive.recoverable).toBe(false);

    const snapLost: HealthSnapshot = {
      reason: 'device-lost',
      detail: { lostReason: 'unknown', message: 'test' },
      recoverable: true,
    };
    expect(snapLost.reason).toBe('device-lost');
    expect(snapLost.recoverable).toBe(true);
    expect(snapLost.detail).toEqual({ lostReason: 'unknown', message: 'test' });

    const snapFault: HealthSnapshot = {
      reason: 'internal-fault',
      detail: { message: 'simulated' },
      recoverable: false,
    };
    expect(snapFault.reason).toBe('internal-fault');
    expect(snapFault.recoverable).toBe(false);
    expect(snapFault.detail).toEqual({ message: 'simulated' });
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// M2 Integration tests (w8 / w9 / w10 — TDD RED)
//
// These tests require a Renderer constructed via createRenderer with a mock RHI
// backend. They are RED until w11 (+ interface) + w12 (+ registry wire) + w13
// (+ implementation) are complete.
// ──────────────────────────────────────────────────────────────────────────────

// ── Mock RHI setup (mirrors asset.unit.test.ts pattern) ──────────────────────

/**
 * Module-level resolver hook so M3 integration tests (w14/w15) can
 * control when device.lost resolves. Set by makeFakeRhiDevice on each call.
 * @internal test-only hook, not part of any package surface.
 */
let _testDeviceLostResolve: ((info: unknown) => void) | null = null;

function makeFakeRhiDevice(): Record<string, unknown> {
  let resolveLost!: (info: unknown) => void;
  const lost = new Promise<unknown>((res) => {
    resolveLost = res;
  });
  _testDeviceLostResolve = resolveLost;
  return {
    __brand: 'RhiDevice',
    lost,
    features: new Set<string>(),
    limits: {} as Record<string, number>,
    // feat-20260707 M5 / w33: createRenderer projects RhiCaps.textureCompression*
    // into TranscodeCaps at registry-build time; the fake device needs a caps
    // object (the real RhiDevice always carries one).
    caps: {
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
    },
    queue: {
      submit: () => undefined,
      writeBuffer: () => undefined,
    },
    createBuffer: () => ({ ok: true, value: { __brand: 'Buffer' } }),
    createTexture: () => ({ ok: true, value: { __brand: 'Texture' } }),
    createBindGroupLayout: () => ({ ok: true, value: { __brand: 'BindGroupLayout' } }),
    createBindGroup: () => ({ ok: true, value: { __brand: 'BindGroup' } }),
    createPipelineLayout: () => ({ ok: true, value: { __brand: 'PipelineLayout' } }),
    createRenderPipeline: () => ({ ok: true, value: { __brand: 'RenderPipeline' } }),
    createSampler: () => ({ ok: true, value: { __brand: 'Sampler' } }),
    createShaderModule: () => ({ ok: true, value: { __brand: 'ShaderModule' } }),
    createTextureView: () => ({ ok: true, value: { __brand: 'TextureView' } }),
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
        }),
        finish: () => ({ __brand: 'CommandBuffer' }),
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
      return actualRhi.ok(makeFakeRhiDevice());
    },
  };
  return {
    rhi: {
      requestAdapter: async () => actualRhi.ok(fakeAdapter),
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
      return actualRhi.ok(makeFakeRhiDevice());
    },
  };
  return {
    rhi: {
      requestAdapter: async () => actualRhi.ok(fakeAdapter),
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

let makeGPUSpy: ReturnType<typeof makeStubGPU>;
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

// Minimal shader manifest as data URL — provides a manifest that the
// ShaderRegistry can parse without HTTP requests, following the
// bind-group-cache-frame.test.ts pattern. Includes a pbr stub with the
// `f_schlick` content marker so `buildReadyWebGPU` finds the PBR entry.
const HEALTH_TEST_MANIFEST_URL = (() => {
  const manifest = {
    schemaVersion: '1.0.0',
    entries: [
      {
        hash: 'pbr00000',
        wgsl: '/* pbr stub - calls f_schlick( */',
        glsl: '',
        bindings: '',
      },
    ],
    materialShaders: [],
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(manifest))}`;
})();

describe('Renderer health/recover integration (M2 RED)', () => {
  beforeEach(() => {
    makeGPUSpy = makeStubGPU();
    vi.stubGlobal('navigator', { ...navigator, gpu: makeGPUSpy });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── w8: health() healthy-state baseline ──────────────────────────────────

  it('w8: health() returns alive baseline when registry has not been fired', async () => {
    const canvas = makeMockCanvas();
    const { createRenderer } = await import('../createRenderer');
    const renderer = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: HEALTH_TEST_MANIFEST_URL },
    );

    // TDD RED: renderer.health() does not exist on Renderer until w11.
    // After w13, this should return { reason: 'alive', recoverable: false }.
    const snapshot = (
      (renderer as unknown as Record<string, unknown>).health as () => HealthSnapshot
    )?.();
    if (!snapshot) {
      // RED guard: health() not yet implemented — test fails here until w13.
      throw new Error('TDD RED: renderer.health() not implemented yet (expected after w11+w13)');
    }
    expect(snapshot.reason).toBe('alive');
    expect(snapshot.recoverable).toBe(false);
  });

  // ── w9: recover() healthy-state returns recover-not-needed (AC-04) ────────
  //
  // feat-20260622-s5 M3 / w19 migration: recover() is now async (device rebuild
  // is async). The alive-state guard returns recover-not-needed synchronously
  // inside the Promise. The full rebuild success/failure-code matrix lives in
  // renderer-recover.unit.test.ts (w10-w14); this stays a health-surface smoke.

  it('w9: recover() on healthy renderer returns recover-not-needed error', async () => {
    const canvas = makeMockCanvas();
    const { createRenderer } = await import('../createRenderer');
    const renderer = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: HEALTH_TEST_MANIFEST_URL },
    );

    const recoverFn = (renderer as unknown as Record<string, unknown>).recover as
      | (() => Promise<Result<void, RecoverError>>)
      | undefined;
    if (!recoverFn) {
      throw new Error('renderer.recover() missing');
    }
    const result = await recoverFn();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('recover-not-needed');
      expect(typeof result.error.expected).toBe('string');
      expect(result.error.expected.length).toBeGreaterThan(0);
      expect(typeof result.error.hint).toBe('string');
      expect(result.error.hint.length).toBeGreaterThan(0);
    }
  });

  // ── w10: recover() on degraded state attempts a rebuild, never fakes alive ─
  //
  // feat-20260622-s5 M3 / w19 migration: the S3 placeholder behaviour
  // (recover-not-implemented, health unchanged) is gone — recover() now runs a
  // single idempotent rebuild. On this minimal single-entry HEALTH manifest the
  // rebuild's engine-SSOT-triple check fails, so recover() resolves
  // recover-device-unavailable and LEAVES health at device-lost (A-AC-07: never
  // fakes the renderer back to alive on failure). The success path (full triple
  // manifest -> ok + alive) is covered in renderer-recover.unit.test.ts (w10).

  it('w10: recover() on degraded renderer attempts rebuild; failure keeps health device-lost', async () => {
    const canvas = makeMockCanvas();
    const { createRenderer } = await import('../createRenderer');
    const renderer = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: HEALTH_TEST_MANIFEST_URL },
    );

    const healthFn = (renderer as unknown as Record<string, unknown>).health as
      | (() => HealthSnapshot)
      | undefined;
    if (!healthFn) {
      throw new Error('renderer.health() missing');
    }
    const recoverFn = (renderer as unknown as Record<string, unknown>).recover as
      | (() => Promise<Result<void, RecoverError>>)
      | undefined;
    if (!recoverFn) {
      throw new Error('renderer.recover() missing');
    }

    // Drive into degraded state via device.lost (same mock path as w14).
    if (!_testDeviceLostResolve) throw new Error('device.lost resolver not set up');
    _testDeviceLostResolve({
      reason: 'unknown',
      message: 'test device lost for w10 degraded-state',
    });

    await vi.waitFor(() => {
      expect(healthFn().reason).toBe('device-lost');
    });
    expect(healthFn().reason).toBe('device-lost');

    // recover() runs a single rebuild attempt. The reserved recover-not-implemented
    // is never produced anymore; on this minimal manifest the rebuild fails with a
    // device-unavailability code.
    const result = await recoverFn();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).not.toBe('recover-not-implemented');
      expect(result.error.code).toBe('recover-device-unavailable');
    }

    // A-AC-07: failure never fakes the renderer back to alive.
    const snapAfter = healthFn();
    expect(snapAfter.reason).toBe('device-lost');
    expect(snapAfter.recoverable).toBe(true);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// M2 draw guard tests (w7 — TDD RED)
//
// These tests verify device-lost draw() silent return + disposed latch. They are
// RED until w9 adds the health-state guard in draw().
// ──────────────────────────────────────────────────────────────────────────────

describe('Renderer draw device-lost guard (w7 TDD RED)', () => {
  beforeEach(() => {
    makeGPUSpy = makeStubGPU();
    vi.stubGlobal('navigator', { ...navigator, gpu: makeGPUSpy });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _testDeviceLostResolve = null;
  });

  // ── w7(a): device-lost -> draw() returns err silently ──────────────────────

  it('w7(a): device-lost state draw() returns Result.err without firing onError each frame', async () => {
    const canvas = makeMockCanvas();
    const { createRenderer } = await import('../createRenderer');
    const renderer = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: HEALTH_TEST_MANIFEST_URL },
    );

    const healthFn = (renderer as unknown as Record<string, unknown>).health as
      | (() => HealthSnapshot)
      | undefined;
    if (!healthFn) {
      throw new Error('TDD RED: renderer.health() not found');
    }

    // Subscribe to onError to verify no per-frame fire
    const onErrorFn = (renderer as unknown as Record<string, unknown>).onError as
      | ((cb: (err: { code: string }) => void) => () => void)
      | undefined;
    if (!onErrorFn) {
      throw new Error('TDD RED: renderer.onError() not found');
    }
    const errorCb = vi.fn<(err: { code: string }) => void>();
    onErrorFn(errorCb);

    // Need a World with Camera to reach draw internals
    const { World } = await import('@forgeax/engine-ecs');
    const { Transform, Camera } = await import('../index');
    const world = new World();
    world.spawn(
      {
        component: Transform,
        data: {
          posX: 0,
          posY: 0,
          posZ: 10,
          quatX: 0,
          quatY: 0,
          quatZ: 0,
          quatW: 1,
          scaleX: 1,
          scaleY: 1,
          scaleZ: 1,
        },
      },
      {
        component: Camera,
        data: {
          fov: Math.PI / 4,
          aspect: 1,
          near: 0.1,
          far: 100,
          clearR: 0,
          clearG: 0,
          clearB: 0,
          clearA: 1,
        },
      },
    );

    await renderer.ready;

    // Baseline: health is alive
    expect(healthFn().reason).toBe('alive');

    // Trigger device-lost
    if (!_testDeviceLostResolve) throw new Error('device.lost resolver not set up');
    _testDeviceLostResolve({
      reason: 'unknown',
      message: 'device lost for draw guard test',
    });

    await vi.waitFor(() => {
      expect(healthFn().reason).toBe('device-lost');
    });

    // Reset error spy counter after lost event (the lost channel itself fires onError once)
    errorCb.mockClear();

    // Draw N=5 times in device-lost state
    for (let i = 0; i < 5; i++) {
      const result = renderer.draw(world);
      // TDD RED / AC-10: draw returns err silently (not ok for device-lost)
      expect(result.ok).toBe(false);
    }

    // TDD RED / AC-10: onError was NOT fired during those 5 draws (silent return)
    // Current behavior (w7 RED): draw fires onError each frame through the normal
    // device-lost flow (dual-channel), or the disposed/rhi-not-available path fires.
    // After w9 fix: zero onError fires for draw() during device-lost.
    expect(errorCb).not.toHaveBeenCalled();
  });

  // ── w7(b): disposed latch — post-dispose lost callback is no-op ────────────

  it('w7(b): disposed latch prevents reconstruction on device-lost event', async () => {
    const canvas = makeMockCanvas();
    const { createRenderer } = await import('../createRenderer');
    const renderer = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: HEALTH_TEST_MANIFEST_URL },
    );

    // TDD RED: dispose then trigger lost — should not try to reconstruct
    const disposeFn = (renderer as unknown as Record<string, unknown>).dispose as
      | (() => void)
      | undefined;
    if (!disposeFn) {
      throw new Error('TDD RED: renderer.dispose() not found');
    }

    disposeFn();

    // After dispose, trigger device.lost (should be no-op, no throw)
    if (!_testDeviceLostResolve) throw new Error('device.lost resolver not set up');
    _testDeviceLostResolve({
      reason: 'destroyed',
      message: 'lost after dispose',
    });

    // Allow microtask flush — no assertion needed beyond "doesn't throw/crash"
    await new Promise((r) => setTimeout(r, 50));

    // TDD RED: disposed renderer.draw returns err
    const { World } = await import('@forgeax/engine-ecs');
    const world = new World();
    const result = renderer.draw(world);
    expect(result.ok).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// M3 Integration tests (w14 / w15 — TDD RED)
//
// These tests verify the device.lost health channel wire. They are RED until
// w16 adds the healthRegistry.fire() call in device.lost.then().
// ──────────────────────────────────────────────────────────────────────────────

describe('Renderer health device.lost integration (M3 RED)', () => {
  beforeEach(() => {
    makeGPUSpy = makeStubGPU();
    vi.stubGlobal('navigator', { ...navigator, gpu: makeGPUSpy });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    _testDeviceLostResolve = null;
  });

  // ── w14: device.lost health update (AC-10) ─────────────────────────────────

  it('w14: device.lost reason=unknown sets health().reason to device-lost with correct detail + recoverable', async () => {
    const canvas = makeMockCanvas();
    const { createRenderer } = await import('../createRenderer');
    const renderer = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: HEALTH_TEST_MANIFEST_URL },
    );

    // TDD RED: health() does not exist on Renderer until w11.
    const healthFn = (renderer as unknown as Record<string, unknown>).health as
      | (() => HealthSnapshot)
      | undefined;
    if (!healthFn) {
      throw new Error('TDD RED: renderer.health() not implemented yet');
    }

    // Baseline: alive before device loss
    expect(healthFn().reason).toBe('alive');

    // Trigger device.lost via the module-level resolver hook. reason 'unknown'
    // = genuine unrecoverable loss (driver crash / TDR) which DOES flip health
    // to device-lost. (reason 'destroyed' = intentional teardown, gated -- see
    // w14b below.)
    if (!_testDeviceLostResolve) throw new Error('device.lost resolver not set up');
    _testDeviceLostResolve({
      reason: 'unknown',
      message: 'device lost (driver crash)',
    });

    // Allow the microtask queue to flush so device.lost.then() fires
    await vi.waitFor(() => {
      expect(healthFn().reason).toBe('device-lost');
    });

    const snap = healthFn();
    expect(snap.reason).toBe('device-lost');
    expect(snap.recoverable).toBe(true);

    // TS discriminated union narrows snap: in 'device-lost' branch detail is
    // HealthDetailDeviceLost with required lostReason (AC-05, no toHaveProperty bypass).
    if (snap.reason === 'device-lost') {
      expect(snap.detail.lostReason).toBe('unknown');
      expect(snap.detail.message).toBe('device lost (driver crash)');
    }
  });

  it('w14: device.lost with unknown reason sets lostReason to unknown', async () => {
    const canvas = makeMockCanvas();
    const { createRenderer } = await import('../createRenderer');
    const renderer = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: HEALTH_TEST_MANIFEST_URL },
    );

    const healthFn = (renderer as unknown as Record<string, unknown>).health as
      | (() => HealthSnapshot)
      | undefined;
    if (!healthFn) {
      throw new Error('TDD RED: renderer.health() not implemented yet');
    }

    // Device lost with reason: 'unknown'
    if (!_testDeviceLostResolve) throw new Error('device.lost resolver not set up');
    _testDeviceLostResolve({
      reason: 'unknown',
      message: '',
    });

    await vi.waitFor(() => {
      expect(healthFn().reason).toBe('device-lost');
    });

    const snap = healthFn();
    if (snap.reason === 'device-lost') {
      expect(snap.detail.lostReason).toBe('unknown');
    }
  });

  // ── w15: onHealthChange callback triggered on device.lost (AC-10) ──────────

  it('w15: onHealthChange callback called exactly once on device.lost', async () => {
    const canvas = makeMockCanvas();
    const { createRenderer } = await import('../createRenderer');
    const renderer = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: HEALTH_TEST_MANIFEST_URL },
    );

    const onHealthChangeFn = (renderer as unknown as Record<string, unknown>).onHealthChange as
      | ((cb: HealthChangeListener) => () => void)
      | undefined;
    if (!onHealthChangeFn) {
      throw new Error('TDD RED: renderer.onHealthChange() not implemented yet');
    }

    const cb = vi.fn<HealthChangeListener>();
    onHealthChangeFn(cb);

    // Before device loss, cb should not have been called
    expect(cb).not.toHaveBeenCalled();

    // Trigger device.lost
    if (!_testDeviceLostResolve) throw new Error('device.lost resolver not set up');
    _testDeviceLostResolve({ reason: 'unknown', message: 'lost' });

    // Wait for the health channel to fire
    await vi.waitFor(() => {
      expect(cb).toHaveBeenCalled();
    });

    // Called exactly once
    expect(cb).toHaveBeenCalledTimes(1);

    // Callback received the correct snapshot
    const snap = cb.mock.calls[0]?.[0];
    expect(snap).toBeDefined();
    if (snap) {
      expect(snap.reason).toBe('device-lost');
      expect(snap.recoverable).toBe(true);
    }
  });

  it('w15: late-attach replay after device.lost fires immediately', async () => {
    const canvas = makeMockCanvas();
    const { createRenderer } = await import('../createRenderer');
    const renderer = await createRenderer(
      canvas,
      {},
      { shaderManifestUrl: HEALTH_TEST_MANIFEST_URL },
    );

    // Trigger device.lost BEFORE registering the callback
    if (!_testDeviceLostResolve) throw new Error('device.lost resolver not set up');
    _testDeviceLostResolve({ reason: 'unknown', message: 'late-attach test' });

    // Flush the microtask so healthRegistry.fire() completes
    const healthFn = (renderer as unknown as Record<string, unknown>).health as
      | (() => HealthSnapshot)
      | undefined;
    if (!healthFn) {
      throw new Error('TDD RED: renderer.health() not implemented yet');
    }

    await vi.waitFor(() => {
      expect(healthFn().reason).toBe('device-lost');
    });

    // Now register callback — late-attach replay should fire immediately
    const onHealthChangeFn = (renderer as unknown as Record<string, unknown>).onHealthChange as
      | ((cb: HealthChangeListener) => () => void)
      | undefined;
    if (!onHealthChangeFn) {
      throw new Error('TDD RED: renderer.onHealthChange() not implemented yet');
    }

    const cb = vi.fn<HealthChangeListener>();
    onHealthChangeFn(cb);

    // Called immediately via late-attach replay
    expect(cb).toHaveBeenCalledTimes(1);
    const snap = cb.mock.calls[0]?.[0];
    expect(snap?.reason).toBe('device-lost');
    expect(snap?.recoverable).toBe(true);
  });
});

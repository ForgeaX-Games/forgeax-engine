// packages/wgpu-wasm/src/__tests__/ensureReady.test.ts — singleton-wrapper contract
// (plan-strategy D-P3 / research F-4).
//
// The three assertions below are the SSOT for the ensureReady contract:
//
// 1. Reference equality across calls (charter proposition 6 Idempotency):
//    ensureReady() === ensureReady() — N calls return the same Promise reference.
// 2. Reference equality across awaits: (await ensureReady()) === (await ensureReady())
//    — the resolved wasm namespace is the same object, N times.
// 3. Retry on transient failure (charter proposition 4 Explicit Failure):
//    if init rejects, the cached rejection is cleared (null-reset) and a subsequent
//    ensureReady() retries _loadWasm(). A second init that succeeds returns the
//    wasm namespace.
//
// The pkg/* imports are mocked because the wasm artefact does not exist until w4
// runs `bash build.sh`; tests focus on the singleton wrapper logic only — wasm load
// itself is exercised by integration tests in @forgeax/engine-rhi-wgpu + @forgeax/engine-naga.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Track the number of init() invocations so we can assert "no second call after success".
/** @internal */
let _initCallCount = 0;
/** @internal */
let _initBehaviour: 'success' | 'reject' = 'success';

vi.mock('../../pkg/wgpu_wasm.js', () => {
  return {
    // Mock the wasm namespace surface (a placeholder identity object stays sufficient
    // for reference-equality assertions; production wasm symbols are not exercised
    // here — that responsibility belongs to integration tests).
    default: vi.fn((_input: unknown) => {
      _initCallCount += 1;
      if (_initBehaviour === 'reject') {
        return Promise.reject(new Error('mock init failure'));
      }
      return Promise.resolve({});
    }),
    parse: vi.fn(),
    validate: vi.fn(),
    emit_reflection: vi.fn(),
    RhiWgpuInstance: { create: vi.fn() },
  };
});

// Mock node:fs/promises so the Node branch of _loadWasm() does not require a
// real wasm artefact on disk (the singleton wrapper's contract is the wasm-load
// boundary itself; the byte content is irrelevant to the contract tests).
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async () => new Uint8Array(0)),
}));

describe('ensureReady singleton wrapper', () => {
  beforeEach(async () => {
    // Reset module state so each test exercises a fresh _instance closure.
    _initCallCount = 0;
    _initBehaviour = 'success';
    vi.resetModules();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns the same Promise reference across N calls (charter proposition 6 idempotency)', async () => {
    const mod = await import('../index.js');
    const p1 = mod.ensureReady();
    const p2 = mod.ensureReady();
    const p3 = mod.ensureReady();
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    // init() must be called exactly once even after 3 ensureReady() calls.
    await p1;
    expect(_initCallCount).toBe(1);
  });

  it('returns the same wasm namespace reference across N awaits (charter proposition 6 idempotency)', async () => {
    const mod = await import('../index.js');
    const ns1 = await mod.ensureReady();
    const ns2 = await mod.ensureReady();
    expect(ns1).toBe(ns2);
    expect(_initCallCount).toBe(1);
  });

  it('retries _loadWasm after transient failure (null-reset, charter proposition 4 retry)', async () => {
    _initBehaviour = 'reject';
    const mod = await import('../index.js');
    // First call rejects — init runs once.
    await expect(mod.ensureReady()).rejects.toThrow('mock init failure');
    expect(_initCallCount).toBe(1);
    // Switch to success — the cached rejection was null-reset, so the next
    // ensureReady() retries _loadWasm and succeeds.
    _initBehaviour = 'success';
    const ns = await mod.ensureReady();
    expect(_initCallCount).toBe(2);
    expect(typeof ns).toBe('object');
  });
});

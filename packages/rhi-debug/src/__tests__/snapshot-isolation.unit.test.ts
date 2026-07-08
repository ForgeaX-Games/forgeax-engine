// Unit tests for the frame-header snapshot path (M3 / w18).
//
// Covers:
//   (1) snapshot isolation (AC-08): snapshotAllLiveResources records initialData
//       events but the snapshot's own copy/submit never leak into tape.events.
//   (2) seed Result narrow (AC-07 CAUTION): replayInitialData returns a narrow
//       'seed-initial-data-failed' code on lookup miss and calls writeBuffer/
//       writeTexture on success — narrowing at the real consumer call site, not
//       a .test-d.ts type assertion.
//   (3) blobPool reuse (AC-12): snapshot bytes flow storeBlob -> dataHash; replay
//       reads them back from tape.blobPool via the same dataHash (no separate
//       init-data pool).

// biome-ignore-all lint/suspicious/noExplicitAny: snapshot unit tests construct stub RHI surfaces (buffer/texture/encoder/queue brands) whose opaque Handle<T> brands require any casts at the mock boundary; WebGPU usage bitflags are native integer enums unavailable at type level here
// biome-ignore-all lint/style/noNonNullAssertion: test assertions index into controlled fixtures whose shape is known at the call site

import { describe, expect, it, vi } from 'vitest';
import type { DebugError } from '../errors';
import { type DebugRhiInstance, wrap } from '../recorder';
import { replayInitialData } from '../replayer';
import type { RhiCallEvent, Tape } from '../types';

function rOk<T>(value: T) {
  return { ok: true as const, value };
}

// ---------------------------------------------------------------
// Mock RhiInstance whose buffers support the readback chain so
// snapshotResource can complete copyBufferToBuffer -> mapAsync ->
// getMappedRange against the staging buffer.
// ---------------------------------------------------------------

interface SnapshotMockEnv {
  copyBufferToBufferSpy: ReturnType<typeof vi.fn>;
  submitSpy: ReturnType<typeof vi.fn>;
}

function buildSnapshotMock(): { inst: any; env: SnapshotMockEnv } {
  const copyBufferToBufferSpy = vi.fn();
  const submitSpy = vi.fn(() => rOk(undefined));

  // Every buffer (including the readback staging buffer) exposes a mapAsync /
  // getMappedRange that returns a Result-wrapped 16-byte range, mirroring the
  // RHI Buffer contract readback.ts depends on.
  function makeBuffer(): any {
    return {
      mapAsync: vi.fn(() => Promise.resolve(rOk(makeMapped()))),
    };
  }
  function makeMapped(): any {
    return {
      getMappedRange: vi.fn(() => rOk(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]).buffer)),
      unmap: vi.fn(),
    };
  }
  function makeEncoder(): any {
    return {
      copyBufferToBuffer: copyBufferToBufferSpy,
      copyTextureToBuffer: vi.fn(),
      finish: vi.fn(() => rOk({})),
    };
  }

  const queue: any = {
    writeBuffer: vi.fn(() => rOk(undefined)),
    writeTexture: vi.fn(() => rOk(undefined)),
    submit: submitSpy,
    onSubmittedWorkDone: vi.fn(() => Promise.resolve(undefined)),
  };

  const device: any = {
    caps: { backendKind: 'webgpu' },
    features: new Set(),
    limits: {},
    queue,
    lost: Promise.resolve({ reason: 'destroyed', message: '' }),
    createBuffer: vi.fn(() => rOk(makeBuffer())),
    createTexture: vi.fn(() => rOk({})),
    createCommandEncoder: vi.fn(() => rOk(makeEncoder())),
    destroyBuffer: vi.fn(() => rOk(undefined)),
    destroyTexture: vi.fn(() => rOk(undefined)),
  };

  const adapter: any = {
    features: new Set(),
    limits: {},
    requestDevice: vi.fn(() => Promise.resolve(rOk(device))),
  };
  const inst: any = { requestAdapter: vi.fn(() => Promise.resolve(rOk(adapter))) };

  return { inst, env: { copyBufferToBufferSpy, submitSpy } };
}

async function bootstrapSnapshot(): Promise<{
  debugInst: DebugRhiInstance;
  device: any;
  env: SnapshotMockEnv;
}> {
  const { inst, env } = buildSnapshotMock();
  const debugInst = wrap(inst);
  const adapterRes = await debugInst.requestAdapter();
  if (!adapterRes.ok) throw new Error('adapter');
  const devRes = await (adapterRes as any).value.requestDevice();
  if (!devRes.ok) throw new Error('device');
  return { debugInst, device: devRes.value, env };
}

// ================================================================
// (1) snapshot isolation (AC-08)
// ================================================================

describe('snapshot isolation (w18)', () => {
  it('snapshotAllLiveResources records initialData but never leaks copy/submit', async () => {
    const { debugInst, device } = await bootstrapSnapshot();

    // Create a load-time buffer before recording begins.
    device.createBuffer({ size: 8, usage: 0x20 });

    const arm = debugInst.arm(1);
    expect(arm.ok).toBe(true);

    const snap = await debugInst.snapshotAllLiveResources();
    expect(snap.ok).toBe(true);
    expect(debugInst.getState()).toBe('recording');

    const events = debugInst.getEvents();
    const kinds = events.map((e) => e.kind);

    // The seed event itself is present...
    expect(kinds).toContain('initialData');
    // ...but the snapshot's own readback copy/submit are isolated by _skipRecord.
    expect(kinds).not.toContain('copyBufferToBuffer');
    expect(kinds).not.toContain('copyTextureToBuffer');
    expect(kinds).not.toContain('submit');
  });

  it('blobPool reuse: snapshot bytes are stored under a dataHash key (AC-12)', async () => {
    const { debugInst, device } = await bootstrapSnapshot();
    device.createBuffer({ size: 8, usage: 0x20 });
    debugInst.arm(1);
    await debugInst.snapshotAllLiveResources();

    const events = debugInst.getEvents();
    const initEvent = events.find((e) => e.kind === 'initialData') as
      | Extract<RhiCallEvent, { kind: 'initialData' }>
      | undefined;
    expect(initEvent).toBeDefined();

    // The dataHash must resolve in the unified blobPool (no separate init pool).
    const pool = debugInst.getBlobPool();
    expect(pool.has(initEvent!.dataHash)).toBe(true);
  });
});

// ================================================================
// (2) seed Result narrow (AC-07 CAUTION) + (3) blobPool consume
// ================================================================

function makeTape(events: RhiCallEvent[], blobPool: Map<string, ArrayBuffer>): Tape {
  return {
    formatVersion: 2,
    rhiCapsRecorded: {
      canvasFormat: 'bgra8unorm',
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
      storageBuffer: false,
      timestampQuery: false,
    } as any,
    events,
    blobPool,
  };
}

describe('replayInitialData Result narrow (w18)', () => {
  it('success: seeds a buffer via queue.writeBuffer from the blobPool', () => {
    const bytes = new Uint8Array([9, 9, 9, 9]).buffer;
    const blobPool = new Map<string, ArrayBuffer>([['hashA', bytes]]);
    const tape = makeTape(
      [
        { kind: 'createBuffer', handleId: 'buf:1', desc: { size: 4, usage: 0x21 } } as RhiCallEvent,
        { kind: 'initialData', handleId: 'buf:1', dataHash: 'hashA' } as RhiCallEvent,
      ],
      blobPool,
    );
    const handleMap = new Map<string, unknown>([['buf:1', { __buffer: true }]]);
    const writeBuffer = vi.fn();
    const queue: any = { writeBuffer, writeTexture: vi.fn() };

    const res = replayInitialData(
      { kind: 'initialData', handleId: 'buf:1', dataHash: 'hashA' },
      tape,
      handleMap,
      queue,
    );

    expect(res.ok).toBe(true);
    expect(writeBuffer).toHaveBeenCalledTimes(1);
    expect(writeBuffer).toHaveBeenCalledWith(expect.anything(), 0, bytes);
  });

  it('success: seeds a texture via queue.writeTexture from the blobPool', () => {
    const bytes = new Uint8Array(16).buffer;
    const blobPool = new Map<string, ArrayBuffer>([['hashT', bytes]]);
    const tape = makeTape(
      [
        {
          kind: 'createTexture',
          handleId: 'tex:1',
          desc: { size: { width: 2, height: 2 }, format: 'rgba8unorm', usage: 0x11 },
        } as RhiCallEvent,
        { kind: 'initialData', handleId: 'tex:1', dataHash: 'hashT' } as RhiCallEvent,
      ],
      blobPool,
    );
    const handleMap = new Map<string, unknown>([['tex:1', { __texture: true }]]);
    const writeTexture = vi.fn();
    const queue: any = { writeBuffer: vi.fn(), writeTexture };

    const res = replayInitialData(
      { kind: 'initialData', handleId: 'tex:1', dataHash: 'hashT' },
      tape,
      handleMap,
      queue,
    );

    expect(res.ok).toBe(true);
    expect(writeTexture).toHaveBeenCalledTimes(1);
  });

  // bug #8 (batch-3 CSM): a texture recorded as bgra8unorm[-srgb] is recreated on
  // the replay device as rgba8unorm[-srgb] (adaptReplayFormat swaps R/B in the
  // FORMAT). The snapshot blob holds raw BGRA bytes; seeding them verbatim into
  // the RGBA texture swaps R<->B for every texel (orange floor -> purple tint).
  // replayInitialData must R/B-swap the seed bytes for bgra source formats so the
  // sampled texel reads identically. Non-bgra formats keep native byte order.
  it('bgra8unorm texture seed: R/B channels swapped before writeTexture', () => {
    // One 1x1 texel: B=10, G=20, R=30, A=40 (BGRA source order).
    const src = new Uint8Array([10, 20, 30, 40]);
    const blobPool = new Map<string, ArrayBuffer>([['hashBgra', src.buffer]]);
    const tape = makeTape(
      [
        {
          kind: 'createTexture',
          handleId: 'tex:bgra',
          desc: { size: { width: 1, height: 1 }, format: 'bgra8unorm', usage: 0x17 },
        } as RhiCallEvent,
        { kind: 'initialData', handleId: 'tex:bgra', dataHash: 'hashBgra' } as RhiCallEvent,
      ],
      blobPool,
    );
    const handleMap = new Map<string, unknown>([['tex:bgra', { __texture: true }]]);
    let capturedData: Uint8Array | undefined;
    const writeTexture = vi.fn((_dst: unknown, data: Uint8Array) => {
      capturedData = data.slice();
      return rOk(undefined);
    });
    const queue: any = { writeBuffer: vi.fn(), writeTexture };

    const res = replayInitialData(
      { kind: 'initialData', handleId: 'tex:bgra', dataHash: 'hashBgra' },
      tape,
      handleMap,
      queue,
    );

    expect(res.ok).toBe(true);
    expect(writeTexture).toHaveBeenCalledTimes(1);
    // After swap the bytes must be RGBA: R=30, G=20, B=10, A=40 (R<->B swapped).
    expect(Array.from(capturedData ?? [])).toEqual([30, 20, 10, 40]);
    // The source blob must be left intact (swap operated on a copy, not the blob).
    expect(Array.from(src)).toEqual([10, 20, 30, 40]);
  });

  it('rgba8unorm texture seed: bytes are NOT swapped (native order preserved)', () => {
    const src = new Uint8Array([10, 20, 30, 40]);
    const blobPool = new Map<string, ArrayBuffer>([['hashRgba', src.buffer]]);
    const tape = makeTape(
      [
        {
          kind: 'createTexture',
          handleId: 'tex:rgba',
          desc: { size: { width: 1, height: 1 }, format: 'rgba8unorm', usage: 0x17 },
        } as RhiCallEvent,
        { kind: 'initialData', handleId: 'tex:rgba', dataHash: 'hashRgba' } as RhiCallEvent,
      ],
      blobPool,
    );
    const handleMap = new Map<string, unknown>([['tex:rgba', { __texture: true }]]);
    let capturedData: Uint8Array | undefined;
    const writeTexture = vi.fn((_dst: unknown, data: Uint8Array) => {
      capturedData = data.slice();
      return rOk(undefined);
    });
    const queue: any = { writeBuffer: vi.fn(), writeTexture };

    const res = replayInitialData(
      { kind: 'initialData', handleId: 'tex:rgba', dataHash: 'hashRgba' },
      tape,
      handleMap,
      queue,
    );

    expect(res.ok).toBe(true);
    expect(Array.from(capturedData ?? [])).toEqual([10, 20, 30, 40]);
  });

  it('failure: handleMap miss returns seed-initial-data-failed (lookup), no write', () => {
    const blobPool = new Map<string, ArrayBuffer>([['hashA', new Uint8Array([1]).buffer]]);
    const tape = makeTape(
      [
        { kind: 'createBuffer', handleId: 'buf:1', desc: { size: 4, usage: 0x21 } } as RhiCallEvent,
        { kind: 'initialData', handleId: 'buf:1', dataHash: 'hashA' } as RhiCallEvent,
      ],
      blobPool,
    );
    const handleMap = new Map<string, unknown>(); // buf:1 absent
    const writeBuffer = vi.fn();
    const queue: any = { writeBuffer, writeTexture: vi.fn() };

    const res = replayInitialData(
      { kind: 'initialData', handleId: 'buf:1', dataHash: 'hashA' },
      tape,
      handleMap,
      queue,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      // Consumer-site narrow on the closed union — exhaustive switch hits the
      // new member, not a default catch-all (AC-07 CAUTION).
      const err = res.error as DebugError;
      switch (err.code) {
        case 'seed-initial-data-failed': {
          const detail = err.detail as { handleId: string; stage: string } | undefined;
          expect(detail?.handleId).toBe('buf:1');
          expect(detail?.stage).toBe('lookup');
          break;
        }
        default:
          throw new Error(`unexpected code ${err.code}`);
      }
    }
    expect(writeBuffer).not.toHaveBeenCalled();
  });

  it('failure: blobPool miss returns seed-initial-data-failed (lookup)', () => {
    const tape = makeTape(
      [
        { kind: 'createBuffer', handleId: 'buf:1', desc: { size: 4, usage: 0x21 } } as RhiCallEvent,
        { kind: 'initialData', handleId: 'buf:1', dataHash: 'missing' } as RhiCallEvent,
      ],
      new Map(),
    );
    const handleMap = new Map<string, unknown>([['buf:1', { __buffer: true }]]);
    const queue: any = { writeBuffer: vi.fn(), writeTexture: vi.fn() };

    const res = replayInitialData(
      { kind: 'initialData', handleId: 'buf:1', dataHash: 'missing' },
      tape,
      handleMap,
      queue,
    );

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('seed-initial-data-failed');
      const detail = res.error.detail as { stage: string } | undefined;
      expect(detail?.stage).toBe('lookup');
    }
  });
});

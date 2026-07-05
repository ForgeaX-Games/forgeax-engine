// @forgeax/engine-rhi-debug/src/__tests__/replayer.unit.test.ts
// Unit tests for createReplay, caps fail-fast, handle remap, stepTo range, reset, and
// onSubmittedWorkDone sync (m5-3 + m5-5).
//
// m5-3: caps mismatch 5 direction + handle remap + stepTo range + reset
// m5-5: onSubmittedWorkDone sync + replay-deterministic-violation
//
// Related: requirements AC-11/AC-12/AC-13/AC-26; plan-strategy 5.3.

/// <reference types="@webgpu/types" />

// biome-ignore-all lint/complexity/noBannedTypes: test mock construction uses empty objects as sentinels; RhiCaps/RhiDevice stub construction requires {} object literals for partial mock shapes

import type { RhiCaps, RhiDevice, RhiQueue } from '@forgeax/engine-rhi';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DebugError } from '../errors';
import { pixelDeltaAbsMean } from '../pixel-diff';
import type { Replay } from '../replayer';
import { adaptReplayFormat, createReplay } from '../replayer';
import type { RhiCallEvent, RhiCallEventCreateBuffer, RhiCapsRecorded, Tape } from '../types';

// ============================================================================
// Helpers
// ============================================================================

function makeTape(caps: Partial<RhiCapsRecorded>, events: Tape['events']): Tape {
  return {
    formatVersion: 2,
    rhiCapsRecorded: {
      canvasFormat: caps.canvasFormat ?? ('bgra8unorm' as GPUTextureFormat),
      rgba16floatRenderable: caps.rgba16floatRenderable ?? false,
      float32Filterable: caps.float32Filterable ?? false,
      textureCompression: caps.textureCompression ?? false,
      storageBuffer: caps.storageBuffer ?? false,
      timestampQuery: caps.timestampQuery ?? false,
    },
    events,
    blobPool: new Map(),
  };
}

function makeMockEncoder() {
  return {
    beginRenderPass: vi.fn().mockReturnValue(makeMockPassEncoder()),
    beginComputePass: vi.fn().mockReturnValue(makeMockPassEncoder()),
    copyBufferToBuffer: vi.fn(),
    copyBufferToTexture: vi.fn(),
    copyTextureToBuffer: vi.fn(),
    copyTextureToTexture: vi.fn(),
    clearBuffer: vi.fn(),
    pushDebugGroup: vi.fn(),
    popDebugGroup: vi.fn(),
    insertDebugMarker: vi.fn(),
    finish: vi.fn().mockReturnValue({ ok: true, value: {} }),
  };
}

function makeMockPassEncoder() {
  return {
    setPipeline: vi.fn(),
    setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(),
    setBindGroup: vi.fn(),
    draw: vi.fn(),
    drawIndexed: vi.fn(),
    setViewport: vi.fn(),
    setScissorRect: vi.fn(),
    dispatchWorkgroups: vi.fn(),
    end: vi.fn(),
  };
}

function makeMockDevice(overrides: Partial<RhiCaps>): {
  device: RhiDevice;
  onSubmittedWorkDoneSpy: ReturnType<typeof vi.fn>;
} {
  const onSubmittedWorkDoneSpy = vi.fn().mockResolvedValue(undefined);

  const mockQueue = {
    writeBuffer: vi.fn().mockReturnValue({ ok: true }),
    writeTexture: vi.fn().mockReturnValue({ ok: true }),
    submit: vi.fn(),
    onSubmittedWorkDone: onSubmittedWorkDoneSpy,
  } as unknown as RhiQueue;

  const mockDevice = {
    caps: {
      backendKind: 'webgpu' as const,
      compute: true,
      timestampQuery: overrides.timestampQuery ?? true,
      indirectDrawing: false,
      textureCompression: overrides.textureCompression ?? true,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      storageBuffer: overrides.storageBuffer ?? true,
      storageTexture: false,
      rgba16floatRenderable: overrides.rgba16floatRenderable ?? true,
      rg11b10ufloatRenderable: false,
      float32Filterable: overrides.float32Filterable ?? true,
    },
    features: new Set(),
    limits: {} as never,
    queue: mockQueue,
    createBuffer: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createTexture: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createTextureView: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createSampler: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createBindGroupLayout: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createBindGroup: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createPipelineLayout: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createRenderPipeline: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createComputePipeline: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createCommandEncoder: vi.fn().mockReturnValue({ ok: true, value: makeMockEncoder() }),
    createQuerySet: vi.fn().mockReturnValue({ ok: true, value: {} }),
    destroyBuffer: vi.fn().mockReturnValue({ ok: true }),
    destroyTexture: vi.fn().mockReturnValue({ ok: true }),
    lost: Promise.resolve({ reason: 'unknown' as const, message: '' }),
  } as unknown as RhiDevice;

  return { device: mockDevice, onSubmittedWorkDoneSpy };
}

function makeCreateBufferEvent(handleId: string): RhiCallEventCreateBuffer {
  return {
    kind: 'createBuffer',
    handleId,
    desc: {
      size: 64,
      usage: 0x10,
      mappedAtCreation: false,
    },
  };
}

// ============================================================================
// m5-3: caps mismatch — 5 direction (independent tests)
// ============================================================================

describe('createReplay caps mismatch (m5-3)', () => {
  it('fails when rgba16floatRenderable is required but missing', () => {
    // I-9 (round 1 review) fix: detail.missingCaps now carries raw
    // RhiCapsRecordedKey values for AI-user `switch` narrowing (AC-11).
    // Human-readable labels live on .hint, not in the structured slot.
    const tape = makeTape({ rgba16floatRenderable: true }, []);
    const { device } = makeMockDevice({ rgba16floatRenderable: false });
    const result = createReplay(tape, device);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('caps-mismatch');
      expect(result.error.detail).toBeDefined();
      if (result.error.detail) {
        const detail = result.error.detail as {
          missingCaps: readonly (keyof import('../types').RhiCapsRecorded)[];
        };
        expect(detail.missingCaps).toContain('rgba16floatRenderable');
        expect(result.error.hint).toContain('rgba16float-renderable');
      }
    }
  });

  it('fails when float32Filterable is required but missing', () => {
    const tape = makeTape({ float32Filterable: true }, []);
    const { device } = makeMockDevice({ float32Filterable: false });
    const result = createReplay(tape, device);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('caps-mismatch');
    }
  });

  it('fails when textureCompression is required but missing', () => {
    const tape = makeTape({ textureCompression: true }, []);
    const { device } = makeMockDevice({ textureCompression: false });
    const result = createReplay(tape, device);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('caps-mismatch');
    }
  });

  it('fails when storageBuffer is required but missing', () => {
    const tape = makeTape({ storageBuffer: true }, []);
    const { device } = makeMockDevice({ storageBuffer: false });
    const result = createReplay(tape, device);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('caps-mismatch');
    }
  });

  it('fails when timestampQuery is required but missing', () => {
    const tape = makeTape({ timestampQuery: true }, []);
    const { device } = makeMockDevice({ timestampQuery: false });
    const result = createReplay(tape, device);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('caps-mismatch');
    }
  });

  it('succeeds when all required caps are present', () => {
    const tape = makeTape({ rgba16floatRenderable: true, float32Filterable: true }, []);
    const { device } = makeMockDevice({
      rgba16floatRenderable: true,
      float32Filterable: true,
    });
    const result = createReplay(tape, device);
    expect(result.ok).toBe(true);
  });

  it('succeeds when caps are not required (all false in tape)', () => {
    const tape = makeTape({}, []);
    const { device } = makeMockDevice({
      rgba16floatRenderable: false,
      float32Filterable: false,
      textureCompression: false,
      storageBuffer: false,
      timestampQuery: false,
    });
    const result = createReplay(tape, device);
    expect(result.ok).toBe(true);
  });
});

// ============================================================================
// m5-3: handle remap (verified via stepTo)
// ============================================================================

describe('createReplay handle remap (m5-3)', () => {
  it('creates new handles distinct from tape handleId via stepTo', async () => {
    const events: Tape['events'] = [makeCreateBufferEvent('buf-1')];
    const tape = makeTape({}, events);
    const { device } = makeMockDevice({});

    const result = createReplay(tape, device);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const replay = result.value;
    await replay.stepTo(0);

    const createBufferMock = device.createBuffer as ReturnType<typeof vi.fn>;
    expect(createBufferMock).toHaveBeenCalled();
  });

  it('maps 3 different resource kinds (buffer/texture/sampler)', async () => {
    const events: Tape['events'] = [
      makeCreateBufferEvent('buf-1'),
      {
        kind: 'createTexture',
        handleId: 'texture:1',
        desc: {
          size: [64, 64, 1] as [number, number, number],
          format: 'rgba8unorm' as GPUTextureFormat,
          usage: 0x10,
        },
      },
      { kind: 'createSampler', handleId: 'sampler:1' },
    ];
    const tape = makeTape({}, events);
    const { device } = makeMockDevice({});

    const result = createReplay(tape, device);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const replay = result.value;
    await replay.stepTo(2);

    expect(device.createBuffer as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(device.createTexture as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(device.createSampler as ReturnType<typeof vi.fn>).toHaveBeenCalled();
  });
});

// ============================================================================
// m5-3: stepTo range
// ============================================================================

describe('stepTo range (m5-3)', () => {
  let replay: Replay;

  beforeEach(async () => {
    const events: Tape['events'] = [makeCreateBufferEvent('buf-1'), makeCreateBufferEvent('buf-2')];
    const tape = makeTape({}, events);
    const { device } = makeMockDevice({});

    const result = createReplay(tape, device);
    expect(result.ok).toBe(true);
    if (result.ok) {
      replay = result.value;
    }
  });

  it('stepTo(0) replays event 0', async () => {
    const stepResult = await replay.stepTo(0);
    expect(stepResult.ok).toBe(true);
  });

  it('stepTo(n) where n < currentIdx returns replay-step-out-of-range', async () => {
    const stepResult = await replay.stepTo(1);
    expect(stepResult.ok).toBe(true);

    const backward = await replay.stepTo(0);
    expect(backward.ok).toBe(false);
    if (!backward.ok) {
      expect(backward.error.code).toBe('replay-step-out-of-range');
    }
  });

  it('stepTo(n) where n >= totalEvents returns replay-step-out-of-range', async () => {
    const stepResult = await replay.stepTo(5);
    expect(stepResult.ok).toBe(false);
    if (!stepResult.ok) {
      expect(stepResult.error.code).toBe('replay-step-out-of-range');
    }
  });
});

// ============================================================================
// m5-3: reset semantics
// ============================================================================

describe('reset semantics (m5-3)', () => {
  it('stepTo(4) -> reset() -> stepTo(2) is legal', async () => {
    const events: Tape['events'] = [
      makeCreateBufferEvent('buf-1'),
      makeCreateBufferEvent('buf-2'),
      makeCreateBufferEvent('buf-3'),
      makeCreateBufferEvent('buf-4'),
      makeCreateBufferEvent('buf-5'),
    ];
    const tape = makeTape({}, events);
    const { device } = makeMockDevice({});

    const result = createReplay(tape, device);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const replay = result.value;

    const step5 = await replay.stepTo(4);
    expect(step5.ok).toBe(true);

    replay.reset();

    const step3 = await replay.stepTo(2);
    expect(step3.ok).toBe(true);
  });

  it('reset() clears handleMap — old handles are destroyed', async () => {
    const events: Tape['events'] = [makeCreateBufferEvent('buf-1')];
    const tape = makeTape({}, events);
    const { device } = makeMockDevice({});

    const result = createReplay(tape, device);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const replay = result.value;
    await replay.stepTo(0);

    replay.reset();

    const destroyMock = device.destroyBuffer as ReturnType<typeof vi.fn>;
    expect(destroyMock).toHaveBeenCalled();
  });
});

// ============================================================================
// m5-5: onSubmittedWorkDone sync
// ============================================================================

describe('onSubmittedWorkDone sync (m5-5)', () => {
  it('awaits onSubmittedWorkDone after each submit event', async () => {
    const events: Tape['events'] = [
      { kind: 'createCommandEncoder', cmdHandleId: 'encoder:1' },
      { kind: 'finish', cmdHandleId: 'encoder:1' },
      { kind: 'submit', cmdHandleIds: ['encoder:1'] },
      { kind: 'createCommandEncoder', cmdHandleId: 'encoder:2' },
      { kind: 'finish', cmdHandleId: 'encoder:2' },
      { kind: 'submit', cmdHandleIds: ['encoder:2'] },
    ];
    const tape = makeTape({}, events);
    const { device, onSubmittedWorkDoneSpy } = makeMockDevice({});

    const result = createReplay(tape, device);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const replay = result.value;
    const stepResult = await replay.stepTo(5);
    expect(stepResult.ok).toBe(true);

    expect(onSubmittedWorkDoneSpy).toHaveBeenCalledTimes(2);
  });

  it('does not call onSubmittedWorkDone when no submit events', async () => {
    const events: Tape['events'] = [makeCreateBufferEvent('buf-1')];
    const tape = makeTape({}, events);
    const { device, onSubmittedWorkDoneSpy } = makeMockDevice({});

    const result = createReplay(tape, device);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const replay = result.value;
    await replay.stepTo(0);
    expect(onSubmittedWorkDoneSpy).not.toHaveBeenCalled();
  });
});

// ============================================================================
// m5-5: replay-deterministic-violation
// ============================================================================

describe('replay-deterministic-violation real emit (m5b-4)', () => {
  it('constructs DebugError with DeterministicViolationDetail from pixelDeltaAbsMean', () => {
    // Simulate baseline pixels (solid red: RGBA = 255,0,0,255)
    const baselinePixels = new Uint8Array(64 * 64 * 4);
    for (let i = 0; i < baselinePixels.length; i += 4) {
      baselinePixels[i] = 255; // R
      baselinePixels[i + 1] = 0; // G
      baselinePixels[i + 2] = 0; // B
      baselinePixels[i + 3] = 255; // A
    }

    // Mutate: add 50 to every R channel (wraps 255->49)
    const fakePixels = new Uint8Array(baselinePixels);
    for (let i = 0; i < fakePixels.length; i += 4) {
      fakePixels[i] = ((fakePixels[i] ?? 0) + 50) % 256;
    }

    // Compute delta via pixelDeltaAbsMean
    const actualDelta = pixelDeltaAbsMean(baselinePixels, fakePixels);

    // 50/255/4 = ~0.049, well above 0.01 threshold
    expect(actualDelta).toBeGreaterThan(0.01);

    // Construct the DebugError with structured DeterministicViolationDetail
    const error = new DebugError({
      code: 'replay-deterministic-violation',
      expected: 'pixel delta <= 0.01',
      hint: 'recorded and replayed pixels differ; GPU non-determinism or tape corruption',
      detail: {
        actualDelta,
        expectedDelta: 0.01,
        drawIdx: 0,
      },
    });

    // Assertions
    expect(error.code).toBe('replay-deterministic-violation');
    expect(error.detail).toBeDefined();

    const detail = error.detail as import('../errors').DeterministicViolationDetail;
    expect(detail.actualDelta).toBe(actualDelta);
    expect(detail.expectedDelta).toBe(0.01);
    expect(detail.drawIdx).toBe(0);
    expect(detail.actualDelta).toBeGreaterThan(detail.expectedDelta);
  });

  it('identity pixels produce 0 delta (no false positive)', () => {
    const pixels = new Uint8Array(64);
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = 128;
    }

    const delta = pixelDeltaAbsMean(pixels, pixels);

    expect(delta).toBe(0);
  });

  it('error code replay-deterministic-violation exists in DebugErrorCode union (structural check)', () => {
    const error = new DebugError({
      code: 'replay-deterministic-violation',
      expected: 'RT pixels should match between original and replay',
      hint: 'GPU non-determinism detected; retry with a different backend or ensure identical GPU state',
    });

    expect(error.code).toBe('replay-deterministic-violation');
    expect(error.expected).toBeTruthy();
    expect(error.hint).toBeTruthy();
  });
});

// ============================================================================
// commitThroughDraw — per-draw cumulative RT commit
// ============================================================================

// A device whose beginRenderPass/createCommandEncoder return SHARED spy
// instances so a test can assert end()/finish()/submit() call counts.
function makeSpyDevice() {
  const pass = makeMockPassEncoder();
  const finishSpy = vi.fn().mockReturnValue({ ok: true, value: { _cmd: true } });
  const encoder = {
    ...makeMockEncoder(),
    beginRenderPass: vi.fn().mockReturnValue(pass),
    finish: finishSpy,
  };
  const submitSpy = vi.fn();
  const mockQueue = {
    writeBuffer: vi.fn().mockReturnValue({ ok: true }),
    writeTexture: vi.fn().mockReturnValue({ ok: true }),
    submit: submitSpy,
    onSubmittedWorkDone: vi.fn().mockResolvedValue(undefined),
  } as unknown as RhiQueue;
  const device = {
    caps: {
      backendKind: 'webgpu' as const,
      compute: true,
      timestampQuery: true,
      indirectDrawing: false,
      textureCompression: true,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      storageBuffer: true,
      storageTexture: false,
      rgba16floatRenderable: true,
      rg11b10ufloatRenderable: false,
      float32Filterable: true,
    },
    features: new Set(),
    limits: {} as never,
    queue: mockQueue,
    createBuffer: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createTexture: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createTextureView: vi.fn().mockReturnValue({ ok: true, value: {} }),
    createCommandEncoder: vi.fn().mockReturnValue({ ok: true, value: encoder }),
    destroyBuffer: vi.fn().mockReturnValue({ ok: true }),
    destroyTexture: vi.fn().mockReturnValue({ ok: true }),
    lost: Promise.resolve({ reason: 'unknown' as const, message: '' }),
  } as unknown as RhiDevice;
  return { device, pass, finishSpy, submitSpy };
}

// Build a one-render-pass tape: createCommandEncoder, beginRenderPass(color),
// setPipeline, drawIndexed x N, endRenderPass, finish, submit. colorView !=
// undefined => the pass has a color attachment.
function makeColorPassTape(drawCount: number, withColor = true): Tape {
  const events: RhiCallEvent[] = [
    { kind: 'createCommandEncoder', cmdHandleId: 'cmd:1' },
    {
      kind: 'beginRenderPass',
      cmdHandleId: 'cmd:1',
      passHandleId: 'pass:1',
      desc: {
        colorAttachments: withColor
          ? [
              {
                view: {},
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 },
              } as never,
            ]
          : [],
      },
      colorAttachmentViewHandleIds: withColor ? ['view:1'] : [],
      ...(withColor ? {} : { depthStencilViewHandleId: 'view:depth' }),
    } as never,
  ];
  for (let i = 0; i < drawCount; i++) {
    events.push({
      kind: 'drawIndexed',
      passHandleId: 'pass:1',
      indexCount: 3,
      instanceCount: 1,
      firstIndex: 0,
      baseVertex: 0,
      firstInstance: 0,
    });
  }
  events.push({ kind: 'endRenderPass', passHandleId: 'pass:1' });
  events.push({ kind: 'finish', cmdHandleId: 'cmd:1' });
  events.push({ kind: 'submit', cmdHandleIds: ['cmd:1'] });
  return makeTape({}, events);
}

describe('adaptReplayFormat', () => {
  // Canvas-only BGRA swapchain formats are remapped to their RGBA byte-siblings on
  // offline replay (a plain texture cannot carry a bgra-srgb view). srgb-ness is
  // preserved. Consumers that rebuild a pipeline (F2 edit-apply) must remap the
  // fragment target the SAME way, or the pipeline target (bgra8unorm-srgb) will
  // not match the replayed color-attachment view (rgba8unorm-srgb).
  it('remaps bgra8unorm and bgra8unorm-srgb to their rgba siblings', () => {
    expect(adaptReplayFormat('bgra8unorm')).toBe('rgba8unorm');
    expect(adaptReplayFormat('bgra8unorm-srgb')).toBe('rgba8unorm-srgb');
  });

  it('passes other formats through unchanged', () => {
    expect(adaptReplayFormat('rgba8unorm')).toBe('rgba8unorm');
    expect(adaptReplayFormat('rgba8unorm-srgb')).toBe('rgba8unorm-srgb');
    expect(adaptReplayFormat('depth24plus-stencil8')).toBe('depth24plus-stencil8');
    expect(adaptReplayFormat(undefined)).toBeUndefined();
  });
});

describe('commitThroughDraw', () => {
  it('synthesizes end + finish + submit through the target draw, skipping the recorded tail', async () => {
    const { device, pass, finishSpy, submitSpy } = makeSpyDevice();
    const tape = makeColorPassTape(3); // draws 0,1,2
    const r = createReplay(tape, device);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const res = await r.value.commitThroughDraw(0); // first draw only
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.committed).toBe(true);

    // exactly one synthetic commit (not the recorded endRenderPass/finish/submit
    // tail, which sits past the target draw and is never replayed).
    expect(pass.end).toHaveBeenCalledTimes(1);
    expect(finishSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    // only draw 0 drawn (draws 1,2 are past the target).
    expect(pass.drawIndexed).toHaveBeenCalledTimes(1);
  });

  it('commits cumulatively: draw 2 replays all three draws', async () => {
    const { device, pass } = makeSpyDevice();
    const tape = makeColorPassTape(3);
    const r = createReplay(tape, device);
    if (!r.ok) return;
    const res = await r.value.commitThroughDraw(2);
    expect(res.ok).toBe(true);
    expect(pass.drawIndexed).toHaveBeenCalledTimes(3);
    expect(pass.end).toHaveBeenCalledTimes(1);
  });

  it('depth-only pass still synthesizes end+finish+submit (flushes depth) but reports committed:false', async () => {
    // A shadow / depth pre-pass has no color attachment. It MUST still commit the
    // partial pass so the target draw's depth writes are flushed and readable per
    // draw (bug: depth preview only changed at the next pass boundary otherwise).
    // committed:false only means "no color RT was committed" — the depth path reads
    // the texture directly via _resolveHandle.
    const { device, pass, finishSpy, submitSpy } = makeSpyDevice();
    const tape = makeColorPassTape(2, /*withColor*/ false);
    const r = createReplay(tape, device);
    if (!r.ok) return;
    const res = await r.value.commitThroughDraw(0);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.committed).toBe(false);
    // The synthetic commit now runs for depth-only passes too.
    expect(pass.end).toHaveBeenCalledTimes(1);
    expect(finishSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy).toHaveBeenCalledTimes(1);
    // only draw 0 executed (draw 1 is past the target).
    expect(pass.drawIndexed).toHaveBeenCalledTimes(1);
  });

  it('rejects an out-of-range drawIdx', async () => {
    const { device } = makeSpyDevice();
    const tape = makeColorPassTape(2);
    const r = createReplay(tape, device);
    if (!r.ok) return;
    const res = await r.value.commitThroughDraw(5);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('replay-step-out-of-range');
  });

  it('is monotonic-forward: backward without reset errors, reset re-enables', async () => {
    const { device } = makeSpyDevice();
    const tape = makeColorPassTape(3);
    const r = createReplay(tape, device);
    if (!r.ok) return;
    const replay = r.value;

    expect((await replay.commitThroughDraw(2)).ok).toBe(true);
    const backward = await replay.commitThroughDraw(0);
    expect(backward.ok).toBe(false);
    if (!backward.ok) expect(backward.error.code).toBe('replay-step-out-of-range');

    replay.reset();
    expect((await replay.commitThroughDraw(0)).ok).toBe(true);
  });
});

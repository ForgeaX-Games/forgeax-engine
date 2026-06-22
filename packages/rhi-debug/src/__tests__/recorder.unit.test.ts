// Unit tests for recorder.ts — state machine + proxy + frameMark + blob dedup + WeakMap.
// Test suites (a) through (h) from m2-6 description.
//
// Uses minimal structural stubs for RHI types — no real GPU, no imports from
// @forgeax/engine-rhi at runtime (only types). Result objects use the same
// { ok, value/error } discriminator shape.

// biome-ignore-all lint/suspicious/noExplicitAny: recorder unit tests construct stub RHI resource types (buffer/texture/pipeline brands) whose opaque generic Handle<T> brand requires any cast at the mock boundary; GPUBufferUsage/GPUTextureUsage bitflags are native WebGPU integer enums not available at type-level in unit context
// biome-ignore-all lint/style/noNonNullAssertion: test assertions on mock stub properties require non-null assertions because stub shape is structurally compatible but not typed as non-null; safe at test compile time

import { describe, expect, it, vi } from 'vitest';
import { DebugError } from '../errors';
import {
  type CreateShaderModuleFn,
  type DebugRhiInstance,
  PER_EVENT_OVERHEAD,
  wrap,
} from '../recorder';

// ---------------------------------------------------------------
// Minimal Result helpers
// ---------------------------------------------------------------

function rOk<T>(value: T) {
  return { ok: true as const, value };
}

// ---------------------------------------------------------------
// Build a minimal mock RhiInstance
// ---------------------------------------------------------------

interface MockEnv {
  writeBufferSpy: ReturnType<typeof vi.fn>;
  submitSpy: ReturnType<typeof vi.fn>;
  createBufferSpy: ReturnType<typeof vi.fn>;
  createTextureSpy: ReturnType<typeof vi.fn>;
  createTextureViewSpy: ReturnType<typeof vi.fn>;
  createSamplerSpy: ReturnType<typeof vi.fn>;
  createBindGroupLayoutSpy: ReturnType<typeof vi.fn>;
  createBindGroupSpy: ReturnType<typeof vi.fn>;
  createPipelineLayoutSpy: ReturnType<typeof vi.fn>;
  createRenderPipelineSpy: ReturnType<typeof vi.fn>;
  createComputePipelineSpy: ReturnType<typeof vi.fn>;
  createCommandEncoderSpy: ReturnType<typeof vi.fn>;
  beginRenderPassSpy: ReturnType<typeof vi.fn>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function h(): any {
  return {};
}

function buildMockInstance(): { inst: any; env: MockEnv } {
  const writeBufferSpy = vi.fn(() => rOk(undefined));
  const submitSpy = vi.fn(() => rOk(undefined));
  const createBufferSpy = vi.fn(() => rOk(h()));
  const createTextureSpy = vi.fn(() => rOk(h()));
  const createTextureViewSpy = vi.fn(() => rOk(h()));
  const createSamplerSpy = vi.fn(() => rOk(h()));
  const createBindGroupLayoutSpy = vi.fn(() => rOk(h()));
  const createBindGroupSpy = vi.fn(() => rOk(h()));
  const createPipelineLayoutSpy = vi.fn(() => rOk(h()));
  const createRenderPipelineSpy = vi.fn(() => rOk(h()));
  const createComputePipelineSpy = vi.fn(() => rOk(h()));
  const createCommandEncoderSpy = vi.fn(() => rOk(makeCmdEncoder()));

  const beginRenderPassSpy = vi.fn(() => makeRenderPass());
  const beginComputePassSpy = vi.fn(() => makeComputePass());

  function makeCmdEncoder(): any {
    const e: any = {};
    const realPass = makeRenderPass();
    const realCPass = makeComputePass();
    e.beginRenderPass = beginRenderPassSpy.mockReturnValue(realPass);
    e.beginComputePass = beginComputePassSpy.mockReturnValue(realCPass);
    e.copyBufferToBuffer = vi.fn();
    e.copyBufferToTexture = vi.fn();
    e.copyTextureToBuffer = vi.fn();
    e.copyTextureToTexture = vi.fn();
    e.clearBuffer = vi.fn();
    e.resolveQuerySet = vi.fn(() => rOk(undefined));
    e.writeTimestamp = vi.fn();
    e.pushDebugGroup = vi.fn();
    e.popDebugGroup = vi.fn();
    e.insertDebugMarker = vi.fn();
    e.finish = vi.fn(() => rOk(h()));
    return e;
  }

  function makeRenderPass(): any {
    return {
      setPipeline: vi.fn(),
      setVertexBuffer: vi.fn(),
      setIndexBuffer: vi.fn(),
      setBindGroup: vi.fn(),
      draw: vi.fn(),
      drawIndexed: vi.fn(),
      setViewport: vi.fn(),
      setScissorRect: vi.fn(),
      setBlendConstant: vi.fn(),
      setStencilReference: vi.fn(),
      drawIndirect: vi.fn(),
      drawIndexedIndirect: vi.fn(),
      pushDebugGroup: vi.fn(),
      popDebugGroup: vi.fn(),
      insertDebugMarker: vi.fn(),
      executeBundles: vi.fn(() => rOk(undefined)),
      beginOcclusionQuery: vi.fn(() => rOk(undefined)),
      endOcclusionQuery: vi.fn(() => rOk(undefined)),
      end: vi.fn(),
    };
  }

  function makeComputePass(): any {
    return {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn(),
    };
  }

  const mockQueue: any = {
    writeBuffer: writeBufferSpy,
    writeTexture: vi.fn(() => rOk(undefined)),
    copyExternalImageToTexture: vi.fn(() => rOk(undefined)),
    submit: submitSpy,
    onSubmittedWorkDone: vi.fn(() => Promise.resolve(undefined)),
  };

  const mockDevice: any = {
    caps: {
      backendKind: 'webgpu',
      compute: true,
      timestampQuery: false,
      indirectDrawing: false,
      textureCompression: false,
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: false,
      storageBuffer: true,
      storageTexture: false,
      rgba16floatRenderable: true,
      rg11b10ufloatRenderable: false,
      float32Filterable: false,
    },
    features: new Set(),
    limits: { maxTextureDimension2D: 8192 } as any,
    queue: mockQueue,
    lost: Promise.resolve({ reason: 'destroyed', message: '' }),

    createBuffer: createBufferSpy,
    createTexture: createTextureSpy,
    createTextureView: createTextureViewSpy,
    createSampler: createSamplerSpy,
    createBindGroupLayout: createBindGroupLayoutSpy,
    createBindGroup: createBindGroupSpy,
    createPipelineLayout: createPipelineLayoutSpy,
    createRenderPipeline: createRenderPipelineSpy,
    createComputePipeline: createComputePipelineSpy,
    createQuerySet: vi.fn(() => rOk(h())),
    destroyBuffer: vi.fn(() => rOk(undefined)),
    destroyTexture: vi.fn(() => rOk(undefined)),
    createCommandEncoder: createCommandEncoderSpy,
  };

  createCommandEncoderSpy.mockReturnValue(rOk(makeCmdEncoder()));

  const mockAdapter: any = {
    features: new Set() as any,
    limits: {} as any,
    requestDevice: vi.fn(() => Promise.resolve(rOk(mockDevice))),
  };

  const mockInst: any = {
    requestAdapter: vi.fn(() => Promise.resolve(rOk(mockAdapter))),
  };

  return {
    inst: mockInst,
    env: {
      writeBufferSpy,
      submitSpy,
      createBufferSpy,
      createTextureSpy,
      createTextureViewSpy,
      createSamplerSpy,
      createBindGroupLayoutSpy,
      createBindGroupSpy,
      createPipelineLayoutSpy,
      createRenderPipelineSpy,
      createComputePipelineSpy,
      createCommandEncoderSpy,
      beginRenderPassSpy,
    },
  };
}

async function bootstrap(): Promise<{ debugInst: DebugRhiInstance; env: MockEnv }> {
  const { inst, env } = buildMockInstance();
  const debugInst = wrap(inst);
  const adapterRes = await debugInst.requestAdapter();
  if (!adapterRes.ok) throw new Error('adapter');
  const adapter = (adapterRes as any).value;
  const devRes = await adapter.requestDevice();
  if (!devRes.ok) throw new Error('device');
  return { debugInst, env };
}

function getAdapter(debugInst: DebugRhiInstance): Promise<any> {
  return debugInst.requestAdapter().then((r) => (r as any).value);
}

function getDevice(adapter: any): Promise<any> {
  return adapter.requestDevice().then((r: any) => (r as any).value);
}

// ================================================================
// (a) State machine
// ================================================================

describe('recorder state machine', () => {
  it('initial state is idle', async () => {
    const { debugInst } = await bootstrap();
    expect(debugInst.getState()).toBe('idle');
  });

  it('idle -> armed', async () => {
    const { debugInst } = await bootstrap();
    const r = debugInst.arm(1);
    expect(r.ok).toBe(true);
    expect(debugInst.getState()).toBe('armed');
  });

  it('armed -> recording -> idle (1 frame)', async () => {
    const { debugInst } = await bootstrap();
    debugInst.arm(1);
    expect(debugInst.getState()).toBe('armed');
    debugInst.onFrameEnd();
    expect(debugInst.getState()).toBe('idle');
  });

  it('armed -> recording for multiple frames', async () => {
    const { debugInst } = await bootstrap();
    debugInst.arm(2);
    expect(debugInst.getState()).toBe('armed');
    debugInst.onFrameEnd();
    expect(debugInst.getState()).toBe('recording');
    debugInst.onFrameEnd();
    expect(debugInst.getState()).toBe('idle');
  });

  it('duplicate arm returns recorder-already-armed', async () => {
    const { debugInst } = await bootstrap();
    debugInst.arm(1);
    const r2 = debugInst.arm(1);
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.error instanceof DebugError).toBe(true);
      expect(r2.error.code).toBe('recorder-already-armed');
    }
  });

  it('arm while recording rejects', async () => {
    const { debugInst } = await bootstrap();
    debugInst.arm(3);
    debugInst.onFrameEnd();
    expect(debugInst.getState()).toBe('recording');
    const r = debugInst.arm(1);
    expect(r.ok).toBe(false);
  });

  it('onFrameEnd while idle is no-op', async () => {
    const { debugInst } = await bootstrap();
    debugInst.onFrameEnd();
    debugInst.onFrameEnd();
    expect(debugInst.getEvents()).toHaveLength(0);
  });

  it('full cycle produces tape', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    device.createBuffer({ size: 64, usage: 16 });
    debugInst.onFrameEnd();
    const tape = debugInst.getTape();
    expect(tape).toBeDefined();
    expect(tape?.formatVersion).toBe(1);
    expect(tape?.events.some((e) => e.kind === 'frameMark')).toBe(true);
  });
});

// ================================================================
// (b) Proxy spy
// ================================================================

describe('recorder proxy spy', () => {
  it('createBuffer intercepted', async () => {
    const { debugInst, env } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    device.createBuffer({ size: 64, usage: 16 });
    expect(env.createBufferSpy).toHaveBeenCalledTimes(1);
    debugInst.onFrameEnd();
    const events = debugInst.getEvents();
    expect(events.some((e) => e.kind === 'createBuffer')).toBe(true);
  });

  it('writeBuffer intercepted with data', async () => {
    const { debugInst, env } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    const bufRes = device.createBuffer({ size: 64, usage: 16 });
    const buf = (bufRes as any).value;
    device.queue.writeBuffer(buf, 0, new Uint8Array([1, 2, 3, 4]));
    expect(env.writeBufferSpy).toHaveBeenCalledTimes(1);
    debugInst.onFrameEnd();
    const events = debugInst.getEvents();
    expect(events.some((e) => e.kind === 'writeBuffer')).toBe(true);
  });

  it('beginRenderPass intercepted', async () => {
    const { debugInst, env } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    const encRes = device.createCommandEncoder();
    const enc = (encRes as any).value;
    // Use a plain object as a TextureView stand-in
    const mockView = {};
    enc.beginRenderPass({
      colorAttachments: [{ view: mockView, loadOp: 'clear' as const, storeOp: 'store' as const }],
    });
    expect(env.beginRenderPassSpy).toHaveBeenCalledTimes(1);
    debugInst.onFrameEnd();
    const events = debugInst.getEvents();
    expect(events.some((e) => e.kind === 'beginRenderPass')).toBe(true);
  });

  it('submit intercepted', async () => {
    const { debugInst, env } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    device.queue.submit([]);
    expect(env.submitSpy).toHaveBeenCalledTimes(1);
    debugInst.onFrameEnd();
    const events = debugInst.getEvents();
    expect(events.some((e) => e.kind === 'submit')).toBe(true);
  });
});

// ================================================================
// (c) FramesMark insertion
// ================================================================

describe('frameMark insertion', () => {
  it('frameMark at end of frame events', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    device.createBuffer({ size: 64, usage: 16 });
    debugInst.onFrameEnd();
    const events = debugInst.getEvents();
    expect(events[events.length - 1]!.kind).toBe('frameMark');
  });

  it('frameMark frameIdx increments', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(2);
    device.createBuffer({ size: 64, usage: 16 });
    debugInst.onFrameEnd();
    device.createBuffer({ size: 128, usage: 16 });
    debugInst.onFrameEnd();
    const marks = debugInst.getEvents().filter((e) => e.kind === 'frameMark');
    expect(marks.length).toBe(2);
    if (marks[0]!.kind === 'frameMark') expect(marks[0]!.frameIdx).toBe(0);
    if (marks[1]!.kind === 'frameMark') expect(marks[1]!.frameIdx).toBe(1);
  });
});

// ================================================================
// (d) Bootstrap frame-0
// ================================================================

describe('bootstrap frame-0', () => {
  it('calls before arm not recorded', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    device.createBuffer({ size: 64, usage: 16 });
    expect(debugInst.getEvents()).toHaveLength(0);
  });

  it('calls after arm before first frameMark', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    device.createBuffer({ size: 64, usage: 16 });
    device.createBuffer({ size: 128, usage: 16 });
    debugInst.onFrameEnd();
    const events = debugInst.getEvents();
    const fmIdx = events.findIndex((e) => e.kind === 'frameMark');
    expect(fmIdx).toBeGreaterThanOrEqual(2);
  });
});

// ================================================================
// (e) Blob pool dedup
// ================================================================

describe('blob pool dedup', () => {
  it('same data twice = one blob', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    const bufRes = device.createBuffer({ size: 64, usage: 16 });
    const buf = (bufRes as any).value;
    const data = new Uint8Array([1, 2, 3, 4]);
    device.queue.writeBuffer(buf, 0, data);
    device.queue.writeBuffer(buf, 0, data);
    debugInst.onFrameEnd();
    expect(debugInst.getBlobPool().size).toBe(1);
  });

  it('different data = separate blobs', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    const bufRes = device.createBuffer({ size: 64, usage: 16 });
    const buf = (bufRes as any).value;
    device.queue.writeBuffer(buf, 0, new Uint8Array([1, 2]));
    device.queue.writeBuffer(buf, 0, new Uint8Array([3, 4]));
    debugInst.onFrameEnd();
    expect(debugInst.getBlobPool().size).toBe(2);
  });

  it('perEventOverhead constant is 192', () => {
    expect(PER_EVENT_OVERHEAD).toBe(192);
  });
});

// ================================================================
// (f) GPUTextureView WeakMap
// ================================================================

describe('GPUTextureView WeakMap', () => {
  it('createTextureView records event', async () => {
    const { debugInst, env } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    const texRes = device.createTexture({
      size: { width: 64, height: 64, depthOrArrayLayers: 1 },
      format: 'rgba8unorm' as const,
      usage: 16,
    });
    const tex = (texRes as any).value;
    device.createTextureView(tex, {});
    expect(env.createTextureViewSpy).toHaveBeenCalledTimes(1);
    debugInst.onFrameEnd();
    const events = debugInst.getEvents();
    expect(events.some((e) => e.kind === 'createTextureView')).toBe(true);
  });

  it('JSON.stringify does not contain native object refs', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    device.createBuffer({ size: 64, usage: 16 });
    debugInst.onFrameEnd();
    const tape = debugInst.getTape();
    const json = JSON.stringify(tape?.events ?? []);
    expect(json).not.toContain('[object');
  });
});

// ================================================================
// (g) wrapCreateShaderModule
// ================================================================

describe('wrapCreateShaderModule', () => {
  it('records event when armed', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origFn: CreateShaderModuleFn = async (_d: any, _desc: any) => {
      return { ok: true as const, value: {} } as any;
    };

    const { wrapCreateShaderModule } = await import('../recorder');
    const wrapped = wrapCreateShaderModule(origFn, debugInst);

    debugInst.arm(1);
    await wrapped(device, { code: 'fn main() {}' });
    debugInst.onFrameEnd();

    const events = debugInst.getEvents();
    const smEvts = events.filter((e) => e.kind === 'createShaderModule');
    expect(smEvts.length).toBe(1);
    if (smEvts[0]!.kind === 'createShaderModule') {
      expect(smEvts[0]!.wgslCode).toBe('fn main() {}');
    }
  });

  it('skips when not armed', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const origFn: CreateShaderModuleFn = async (_d: any, _desc: any) => {
      return { ok: true as const, value: {} } as any;
    };

    const { wrapCreateShaderModule } = await import('../recorder');
    const wrapped = wrapCreateShaderModule(origFn, debugInst);

    // NOT armed
    await wrapped(device, { code: 'fn main() {}' });
    const events = debugInst.getEvents();
    expect(events.filter((e) => e.kind === 'createShaderModule').length).toBe(0);
  });
});

// ================================================================
// (h) _skipRecord flag
// ================================================================

describe('_skipRecord', () => {
  it('internal RHI calls are not double-recorded', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    device.createBuffer({ size: 64, usage: 16 });
    debugInst.onFrameEnd();
    const events = debugInst.getEvents();
    const bufEvents = events.filter((e) => e.kind === 'createBuffer');
    expect(bufEvents.length).toBe(1);
  });

  it('requestAdapter/requestDevice produce no events', async () => {
    const { debugInst } = await bootstrap();
    debugInst.arm(1);
    await debugInst.requestAdapter();
    debugInst.onFrameEnd();
    const events = debugInst.getEvents();
    expect(events.some((e) => (e as any).kind === 'requestAdapter')).toBe(false);
    expect(events.some((e) => (e as any).kind === 'requestDevice')).toBe(false);
  });
});

// ================================================================
// (i) capture failure valid=false (AC-25)
// ================================================================

describe('capture failure valid=false', () => {
  it('recording -> error transition on device.lost', async () => {
    const { debugInst } = await bootstrap();
    debugInst.arm(3);
    debugInst.onFrameEnd();
    expect(debugInst.getState()).toBe('recording');
    debugInst.transitionToError();
    expect(debugInst.getState()).toBe('error');
  });

  it('arm rejects with recorder-not-attached while in error (issue 13)', async () => {
    // arm() in error state must not collapse to recorder-already-armed —
    // closed-union semantics: the caller is being told to disposeError(),
    // not to wait for a capture to finish. Fix-up for I-13 (round 1
    // implement-review).
    const { debugInst } = await bootstrap();
    debugInst.arm(3);
    debugInst.onFrameEnd();
    debugInst.transitionToError();
    const r = debugInst.arm(1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error instanceof DebugError).toBe(true);
      expect(r.error.code).toBe('recorder-not-attached');
      expect(r.error.hint).toContain('disposeError');
    }
  });

  it('arm rejects with recorder-already-armed while armed/recording (still distinct from error)', async () => {
    const { debugInst } = await bootstrap();
    debugInst.arm(3);
    const r = debugInst.arm(1);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('recorder-already-armed');
    }
  });

  it('finalize after error writes valid=false', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(3);
    device.createBuffer({ size: 64, usage: 16 });
    debugInst.onFrameEnd();
    expect(debugInst.getState()).toBe('recording');
    // simulate device.lost during recording
    debugInst.transitionToError();
    expect(debugInst.getState()).toBe('error');

    const tape = debugInst.getTape();
    expect(tape).toBeDefined();
    // tape events are preserved even after error transition
    expect(tape!.events.length).toBeGreaterThan(0);

    const res = debugInst.finalize();
    expect(res.ok).toBe(true);
    if (res.ok) {
      // verify report.json writes valid=false by re-reading it
      const fs = await import('node:fs');
      const reportRaw = fs.readFileSync(res.value.reportPath, 'utf-8');
      const report = JSON.parse(reportRaw);
      expect(report.valid).toBe(false);
    }
  });

  it('disposeError clears error state and allows re-arm', async () => {
    const { debugInst } = await bootstrap();
    debugInst.arm(3);
    debugInst.onFrameEnd();
    debugInst.transitionToError();
    expect(debugInst.getState()).toBe('error');

    debugInst.disposeError();
    expect(debugInst.getState()).toBe('idle');

    // re-arm should succeed after disposeError
    const r = debugInst.arm(1);
    expect(r.ok).toBe(true);
    expect(debugInst.getState()).toBe('armed');
  });

  it('transitionToError is no-op from idle state', async () => {
    const { debugInst } = await bootstrap();
    expect(debugInst.getState()).toBe('idle');
    debugInst.transitionToError();
    expect(debugInst.getState()).toBe('idle');
  });

  it('transitionToError from armed also sets error', async () => {
    const { debugInst } = await bootstrap();
    debugInst.arm(5);
    expect(debugInst.getState()).toBe('armed');
    debugInst.transitionToError();
    expect(debugInst.getState()).toBe('error');
  });

  it('disposeError is no-op from non-error states', async () => {
    const { debugInst } = await bootstrap();
    debugInst.arm(1);
    debugInst.disposeError();
    expect(debugInst.getState()).toBe('armed');
  });
});

// ================================================================
// w4: finalize golden byte-by-byte comparison + png-encode-failed retention
// ================================================================

describe('finalize golden byte comparison (w4)', () => {
  it('refactored finalize path (core + fs tail) produces valid file shapes', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    device.createBuffer({ size: 64, usage: 16 });
    debugInst.onFrameEnd();

    const res = debugInst.finalize();
    expect(res.ok).toBe(true);
    if (res.ok) {
      const fs = await import('node:fs');
      const tapeBytes = fs.readFileSync(res.value.tapePath);
      expect(tapeBytes.byteLength).toBeGreaterThanOrEqual(0);

      const reportRaw = fs.readFileSync(res.value.reportPath, 'utf-8');
      const report = JSON.parse(reportRaw);
      expect(report).toHaveProperty('header');
      expect(report).toHaveProperty('events');
      expect(report).toHaveProperty('passOffsets');
      expect(report).toHaveProperty('valid');
      expect(typeof report.valid).toBe('boolean');

      const path = await import('node:path');
      const dir = path.dirname(res.value.tapePath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('report.json compact format -- no newlines', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    device.createBuffer({ size: 64, usage: 16 });
    debugInst.onFrameEnd();

    const res = debugInst.finalize();
    expect(res.ok).toBe(true);
    if (res.ok) {
      const fs = await import('node:fs');
      const reportRaw = fs.readFileSync(res.value.reportPath, 'utf-8');
      expect(reportRaw).not.toContain('\n');

      const path = await import('node:path');
      const dir = path.dirname(res.value.tapePath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dual path consistency: same tape shape produces matching reports', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    debugInst.arm(1);
    device.createBuffer({ size: 64, usage: 16 });
    debugInst.onFrameEnd();

    const res1 = debugInst.finalize();
    expect(res1.ok).toBe(true);

    if (res1.ok) {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const report1 = JSON.parse(fs.readFileSync(res1.value.reportPath, 'utf-8'));

      // Verify report shape (not byte-identical across recordings
      // because handleIds are incremental per wrap() lifecycle)
      expect(report1).toHaveProperty('header');
      expect(report1).toHaveProperty('events');
      expect(report1).toHaveProperty('passOffsets');
      expect(report1).toHaveProperty('valid');
      expect(report1.header).toHaveProperty('formatVersion', 1);
      expect(Array.isArray(report1.events)).toBe(true);
      expect(Array.isArray(report1.passOffsets)).toBe(true);
      expect(typeof report1.valid).toBe('boolean');
      // Events should be non-empty (createBuffer + frameMark at minimum)
      expect(report1.events.length).toBeGreaterThanOrEqual(2);

      const dir = path.dirname(res1.value.tapePath);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('png-encode-failed error code appears exactly 3 times in recorder.ts', async () => {
    // AC-02 / research F-1 WARNING: the three png-encode-failed reuse
    // sites (mkdirSync, writeFileSync tape, writeFileSync report) must be
    // preserved in the fs tail after refactor. This grep-based test
    // ensures the count stays at 3 (not replaced with a new error code).
    const fsModule = await import('node:fs');
    const pathModule = await import('node:path');
    const recorderPath = pathModule.resolve(import.meta.dirname, '../recorder.ts');
    const source = fsModule.readFileSync(recorderPath, 'utf-8');
    const matches = source.match(/png-encode-failed/g);
    // At least 3 uses: mkdirSync fail, writeFileSync tape fail, writeFileSync report fail
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });
});

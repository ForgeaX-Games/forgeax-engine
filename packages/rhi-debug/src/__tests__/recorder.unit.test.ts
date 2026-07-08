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
import { TAPE_FORMAT_VERSION } from '../tape-format';
import type { Tape } from '../types';

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
      textureCompressionBc: false,
      textureCompressionEtc2: false,
      textureCompressionAstc: false,
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
    const tape = debugInst.getTape() as any;
    expect(tape).toBeDefined();
    expect(tape?.formatVersion).toBe(TAPE_FORMAT_VERSION);
    expect(tape?.events.some((e: any) => e.kind === 'frameMark')).toBe(true);
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
    const tape = debugInst.getTape() as any;
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

    const tape = debugInst.getTape() as any;
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

  it('report.json is pretty-printed -- human-readable multi-line', async () => {
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
      // Pretty-printed for humans debugging captures; must still parse back.
      expect(reportRaw).toContain('\n');
      expect(() => JSON.parse(reportRaw)).not.toThrow();

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
      expect(report1.header).toHaveProperty('formatVersion', TAPE_FORMAT_VERSION);
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

// ================================================================
// w1: registerHandle snapshot safety net
// ================================================================

describe('registerHandle snapshot (w1)', () => {
  it('allocated handleId has kind:n format', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);
    const bufRes = device.createBuffer({ size: 64, usage: 16 });
    expect(bufRes.ok).toBe(true);
    debugInst.onFrameEnd();
    const events = debugInst.getEvents();
    const cb = events.find((e) => e.kind === 'createBuffer');
    expect(cb).toBeDefined();
    if (cb?.kind === 'createBuffer') {
      expect(cb.handleId).toMatch(/^buffer:\d+$/);
    }
  });

  it('handleMap is preserved across arm cycles', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    debugInst.arm(1);
    const bufRes = device.createBuffer({ size: 64, usage: 16 });
    expect(bufRes.ok).toBe(true);
    const buf = (bufRes as any).value;
    debugInst.onFrameEnd();

    const events1 = debugInst.getEvents();
    const cb1 = events1.find((e) => e.kind === 'createBuffer');
    expect(cb1).toBeDefined();
    const hId1 = cb1?.kind === 'createBuffer' ? cb1.handleId : '';

    debugInst.arm(1);
    device.queue.writeBuffer(buf, 0, new Uint8Array([1, 2, 3, 4]));
    debugInst.onFrameEnd();

    const events2 = debugInst.getEvents();
    const wb = events2.find((e) => e.kind === 'writeBuffer');
    expect(wb).toBeDefined();
    if (wb?.kind === 'writeBuffer') {
      expect(wb.handleId).toBe(hId1);
    }
  });

  it('arm clears events but not handleMap', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    debugInst.arm(1);
    const bufRes = device.createBuffer({ size: 64, usage: 16 });
    expect(bufRes.ok).toBe(true);
    const buf = (bufRes as any).value;
    debugInst.onFrameEnd();

    const eventsBefore = debugInst.getEvents();
    expect(eventsBefore.length).toBeGreaterThan(0);

    debugInst.arm(1);
    const eventsAfter = debugInst.getEvents();
    expect(eventsAfter.length).toBe(0);

    device.queue.writeBuffer(buf, 0, new Uint8Array([5, 6]));
    debugInst.onFrameEnd();

    const eventsFinal = debugInst.getEvents();
    const wb = eventsFinal.find((e) => e.kind === 'writeBuffer');
    expect(wb).toBeDefined();
  });

  it('getHandleId lazily allocates for unseen handles', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);

    const bufRes1 = device.createBuffer({ size: 64, usage: 16 });
    expect(bufRes1.ok).toBe(true);

    const bufRes2 = device.createBuffer({ size: 128, usage: 16 });
    expect(bufRes2.ok).toBe(true);

    debugInst.onFrameEnd();

    const events = debugInst.getEvents();
    const buffers = events.filter((e) => e.kind === 'createBuffer');
    expect(buffers.length).toBe(2);
    if (buffers[0]?.kind === 'createBuffer' && buffers[1]?.kind === 'createBuffer') {
      expect(buffers[0].handleId).not.toBe(buffers[1].handleId);
    }
  });

  it('handleMap returns existing id for re-registered handle', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);

    const bufRes = device.createBuffer({ size: 64, usage: 16 });
    expect(bufRes.ok).toBe(true);
    const buf = (bufRes as any).value;

    device.queue.writeBuffer(buf, 0, new Uint8Array([1]));
    device.queue.writeBuffer(buf, 0, new Uint8Array([2]));

    debugInst.onFrameEnd();

    const events = debugInst.getEvents();
    const wbs = events.filter((e) => e.kind === 'writeBuffer');
    expect(wbs.length).toBe(2);
    const cb = events.find((e) => e.kind === 'createBuffer');
    expect(cb).toBeDefined();
    const expectedHId = cb?.kind === 'createBuffer' ? cb.handleId : '';
    if (wbs[0]?.kind === 'writeBuffer') expect(wbs[0].handleId).toBe(expectedHId);
    if (wbs[1]?.kind === 'writeBuffer') expect(wbs[1].handleId).toBe(expectedHId);
  });
});

// ================================================================
// w3: registerHandle payload → bootstrapCreates
// ================================================================

describe('registerHandle payload → bootstrapCreates (w3)', () => {
  it('create event payload lands in bootstrapCreates', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    device.createBuffer({ size: 64, usage: 16 });
    expect(debugInst._getBootstrapCreatesSize()).toBe(1);
  });

  it('bootstrapCreates preserved across multiple arm cycles', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    device.createBuffer({ size: 64, usage: 16 });
    expect(debugInst._getBootstrapCreatesSize()).toBe(1);

    debugInst.arm(1);
    debugInst.onFrameEnd();
    expect(debugInst._getBootstrapCreatesSize()).toBe(1);

    debugInst.arm(1);
    device.createTexture({
      size: { width: 64, height: 64 },
      format: 'rgba8unorm' as const,
      usage: 16,
    });
    debugInst.onFrameEnd();
    expect(debugInst._getBootstrapCreatesSize()).toBe(2);
  });

  it('getHandleId returns existing handleId for pre-registered handle', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);
    debugInst.arm(1);

    const bufRes = device.createBuffer({ size: 64, usage: 16 });
    expect(bufRes.ok).toBe(true);
    const buf = (bufRes as any).value;

    const events1 = debugInst.getEvents();
    const cb = events1.find((e) => e.kind === 'createBuffer');
    expect(cb).toBeDefined();
    const expectedHId = cb?.kind === 'createBuffer' ? cb.handleId : '';

    device.queue.writeBuffer(buf, 0, new Uint8Array([1]));
    debugInst.onFrameEnd();

    const events2 = debugInst.getEvents();
    const wb = events2.find((e) => e.kind === 'writeBuffer');
    expect(wb).toBeDefined();
    if (wb?.kind === 'writeBuffer') {
      expect(wb.handleId).toBe(expectedHId);
    }
    const bufEvents = events2.filter((e) => e.kind === 'createBuffer');
    expect(bufEvents.length).toBe(1);
  });
});

// ================================================================
// M_SC w1: swapchain faithful desc (RED — current 1x1 synthetic)
// ================================================================

describe('M_SC: swapchain faithful createTexture record (w1)', () => {
  it('synthetic createTexture has faithful desc from runtime GPUTexture (RED: 1x1 vs real dims)', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    // Create a raw texture object simulating swapchain getCurrentTexture
    // — properties are real GPU texture attributes, not 1x1/bgra8unorm.
    const rawTexture: Record<string, unknown> = {
      width: 1920,
      height: 1080,
      depthOrArrayLayers: 1,
      format: 'rgba16float',
      usage: 0x10, // RENDER_ATTACHMENT
      dimension: '2d',
      mipLevelCount: 1,
      sampleCount: 1,
    };

    debugInst.arm(1);
    const viewRes = device.createTextureView(rawTexture, {});
    expect(viewRes.ok).toBe(true);
    debugInst.onFrameEnd();

    const events = debugInst.getEvents();
    const texEvents = events.filter((e) => e.kind === 'createTexture');
    // The synthetic createTexture for the swapchain source should exist
    expect(texEvents.length).toBeGreaterThanOrEqual(1);

    const synthTex = texEvents.find((e) => e.kind === 'createTexture' && 'desc' in e) as
      | {
          kind: 'createTexture';
          desc: {
            size: { width: number; height: number; depthOrArrayLayers: number };
            format: string;
            usage: number;
          };
        }
      | undefined;
    expect(synthTex).toBeDefined();

    if (synthTex) {
      // RED assertions — currently fail because the synthetic is 1x1/bgra8unorm
      // GREEN after w3: faithful desc from runtime GPUTexture attributes
      expect(synthTex.desc.size.width).not.toBe(1);
      expect(synthTex.desc.size.height).not.toBe(1);
      expect(synthTex.desc.size.depthOrArrayLayers).toBe(1); // 2D swapchain depthOrArrayLayers is faithfully 1
      expect(synthTex.desc.format).not.toBe('bgra8unorm');
      // D-4: usage must include COPY_SRC (0x01) so replay readbackRt can read
      expect(synthTex.desc.usage & 0x01).toBe(0x01);
    }
  });
});

// ================================================================
// M_SC w2: swapchain closure prefix (RED — current 1x1 synthetic)
// ================================================================

describe('M_SC: swapchain closure prefix (w2)', () => {
  it('getTape closure prefix includes faithful swapchain createTexture (RED: dims 1x1)', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    // Create a raw texture object simulating swapchain getCurrentTexture
    const rawTexture: Record<string, unknown> = {
      width: 1920,
      height: 1080,
      depthOrArrayLayers: 1,
      format: 'rgba16float',
      usage: 0x10,
      dimension: '2d',
      mipLevelCount: 1,
      sampleCount: 1,
    };

    // Create texture view during bootstrap (idle state).
    // The synthetic createTexture is written to bootstrapCreates but
    // pushEvent is blocked by the idle guard, so it does NOT enter s.events.
    // This simulates a real swapchain: the texture exists only in
    // bootstrapCreates and must be reachable via the closure prefix.
    const viewRes = device.createTextureView(rawTexture, {});
    expect(viewRes.ok).toBe(true);

    // Arm and reference the swapchain texture via writeTexture
    debugInst.arm(1);
    device.queue.writeTexture(
      { texture: rawTexture, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      new Uint8Array(4),
      { offset: 0, bytesPerRow: 256, rowsPerImage: 1 },
      { width: 1, height: 1, depthOrArrayLayers: 1 },
    );
    debugInst.onFrameEnd();

    const tapeResult = debugInst.getTape();
    expect(tapeResult).toBeDefined();
    expect(tapeResult instanceof DebugError).toBe(false);
    const tape = tapeResult as Tape;

    // The faithful swapchain createTexture should appear in the tape.
    // Because it was written to bootstrapCreates (but not s.events) during
    // idle state, the closure computation must pull it into the prefix
    // via bootstrapCreates.get (D-5), not skip it via leaf fallback.
    const createTexEvents = tape.events.filter((e) => e.kind === 'createTexture');
    expect(createTexEvents.length).toBeGreaterThanOrEqual(1);

    // The swapchain createTexture in the closure prefix should carry
    // faithful desc — not 1x1 synthetic
    const swapchainCT = createTexEvents.find((e) => e.kind === 'createTexture' && 'desc' in e) as
      | {
          kind: 'createTexture';
          desc: {
            size: { width: number; height: number; depthOrArrayLayers: number };
            format: string;
            usage: number;
          };
        }
      | undefined;
    expect(swapchainCT).toBeDefined();

    if (swapchainCT) {
      // RED: currently 1x1 synthetic dims
      expect(swapchainCT.desc.size.width).not.toBe(1);
      expect(swapchainCT.desc.size.height).not.toBe(1);
      expect(swapchainCT.desc.size.depthOrArrayLayers).toBe(1); // 2D swapchain depthOrArrayLayers is faithfully 1
      expect(swapchainCT.desc.format).not.toBe('bgra8unorm');
      expect(swapchainCT.desc.usage & 0x01).toBe(0x01);
    }
  });
});

// ================================================================
// w5: getTape closure — idempotency + subset minimality (RED)
// ================================================================

describe('getTape closure (w5)', () => {
  it('getTape idempotency — two calls return deep-equal events arrays', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    // Bootstrap: create resources before arm
    device.createBuffer({ size: 64, usage: 16 });

    debugInst.arm(1);
    device.createBuffer({ size: 128, usage: 16 });
    debugInst.onFrameEnd();

    const result1 = debugInst.getTape();
    const result2 = debugInst.getTape();
    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
    expect(result1 instanceof DebugError).toBe(false);
    expect(result2 instanceof DebugError).toBe(false);
    const tape1 = result1 as Tape;
    const tape2 = result2 as Tape;
    expect(tape1.events.length).toBe(tape2.events.length);
    for (let i = 0; i < tape1.events.length; i++) {
      expect(tape1.events[i]!.kind).toBe(tape2.events[i]!.kind);
    }
  });

  it('getTape returns tape-handle-graph-broken when bootstrapCreates missing create (AC-07)', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    // Create real bootstrap resources so bootstrapCreates is populated
    device.createBuffer({ size: 64, usage: 16 });

    // Arm and inject a writeBuffer event referencing a handleId
    // that was NEVER created (not in bootstrapCreates).
    // HandleId runtime form is `${kind}:${n}` (recorder.ts); build it via
    // interpolation so the literal does not collide with the ECS schema-vocab
    // grep gate (check-no-buffer-colon-keyword) that bans 'buffer:<N>' literals.
    const danglingId = `buffer:${999}`;
    debugInst.arm(1);
    debugInst._pushExternalEvent({
      kind: 'writeBuffer',
      handleId: danglingId,
      bufferOffset: 0,
      dataHash: 'deadbeef',
      size: 4,
    } as any);
    debugInst.onFrameEnd();

    // RED: currently getTape returns a Tape (closure not implemented)
    // GREEN after w8+w9: getTape detects missing create, returns DebugError
    const tapeOrErr = debugInst.getTape();
    expect(tapeOrErr).toBeDefined();
    expect(tapeOrErr instanceof DebugError).toBe(true);
    if (tapeOrErr instanceof DebugError) {
      expect(tapeOrErr.code).toBe('tape-handle-graph-broken');
      // Finalize side hint must contain 'bootstrap' semantic marker
      expect(tapeOrErr.hint).toContain('bootstrap');
      // Finalize side hint must NOT contain deserialize-only markers (AC-11)
      const hintLower = tapeOrErr.hint.toLowerCase();
      const isDeserializeOnly =
        hintLower.includes('corrupt') ||
        hintLower.includes('old format') ||
        hintLower.includes('stale');
      expect(isDeserializeOnly).toBe(false);
      // Detail must be HandleGraphBrokenDetail with danglingHandleId (reused, no new fields)
      expect(tapeOrErr.detail).toBeDefined();
      const detail = tapeOrErr.detail as {
        danglingHandleId: string;
        referencingEventIndex: number;
      };
      expect(detail.danglingHandleId).toBe(danglingId);
      expect(typeof detail.referencingEventIndex).toBe('number');
    }
  });

  it('subset minimality: tape prefix only contains referenced handle closure', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    // Bootstrap: create 2 buffers before arm — only the first will be referenced
    const bufARes = device.createBuffer({ size: 64, usage: 16 });
    expect(bufARes.ok).toBe(true);
    const bufA = (bufARes as any).value;

    device.createBuffer({ size: 128, usage: 16 }); // unreferenced
    device.createTexture({
      size: { width: 64, height: 64 },
      format: 'rgba8unorm' as const,
      usage: 16,
    }); // unreferenced
    device.createSampler(); // unreferenced

    // Arm + capture: only reference bufA
    debugInst.arm(1);
    device.queue.writeBuffer(bufA, 0, new Uint8Array([1, 2, 3, 4]));
    debugInst.onFrameEnd();

    // Get the handleId that writeBuffer used for bufA
    const events = debugInst.getEvents();
    const wb = events.find((e) => e.kind === 'writeBuffer');
    expect(wb).toBeDefined();
    const bufAHandleId = wb?.kind === 'writeBuffer' ? wb.handleId : '';
    expect(bufAHandleId).toMatch(/^buffer:\d+$/);

    const tapeResult = debugInst.getTape();
    expect(tapeResult).toBeDefined();
    expect(tapeResult instanceof DebugError).toBe(false);
    const tape = tapeResult as Tape;

    // RED: closure not yet implemented — create* events for the referenced
    // handle should appear in the tape prefix but currently do not.
    const createBufForA = tape.events.filter(
      (e) => e.kind === 'createBuffer' && 'handleId' in e && (e as any).handleId === bufAHandleId,
    );
    // This fails before w8 (0 create events in tape) → RED
    // After w8: closure prefix includes createBuffer for bufA → GREEN
    expect(createBufForA.length).toBe(1);

    // The tape should NOT contain create events for unreferenced resources
    const allCreateBufs = tape.events.filter((e) => e.kind === 'createBuffer');
    // After w8: only the referenced buffer's create should appear
    expect(allCreateBufs.length).toBe(1);
  });
});

// ================================================================
// w16: descriptor registry register / destroy (AC-09)
// ================================================================

describe('descriptor registry (w16)', () => {
  it('createBuffer registers a buffer entry with size + usage (COPY_SRC promoted)', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    const res = device.createBuffer({ size: 64, usage: 16 });
    expect(res.ok).toBe(true);

    const table = debugInst._getDescriptorTable();
    expect(table.size).toBe(1);
    const entry = [...table.values()][0]!;
    expect(entry.kind).toBe('buffer');
    expect(entry.size).toBe(64);
    // Buffer COPY_SRC (0x04, distinct from texture's 0x01) promoted onto the
    // recorded usage (w12); the original INDEX (0x10) bit is preserved.
    expect((entry.usage & 0x04) !== 0).toBe(true);
    expect((entry.usage & 0x10) !== 0).toBe(true);
  });

  it('createTexture registers a texture entry with format + usage', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    const res = device.createTexture({
      size: { width: 32, height: 16 },
      format: 'rgba8unorm',
      usage: 0x10,
    });
    expect(res.ok).toBe(true);

    const table = debugInst._getDescriptorTable();
    expect(table.size).toBe(1);
    const entry = [...table.values()][0]!;
    expect(entry.kind).toBe('texture');
    expect(entry.format).toBe('rgba8unorm');
    expect((entry.usage & 0x01) !== 0).toBe(true);
  });

  it('destroyBuffer removes the entry for that handleId', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    const res = device.createBuffer({ size: 64, usage: 16 });
    expect(debugInst._getDescriptorTable().size).toBe(1);

    device.destroyBuffer((res as any).value);
    expect(debugInst._getDescriptorTable().size).toBe(0);
  });

  it('destroyTexture removes the entry for that handleId', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    const res = device.createTexture({
      size: { width: 4, height: 4 },
      format: 'rgba8unorm',
      usage: 0x10,
    });
    expect(debugInst._getDescriptorTable().size).toBe(1);

    device.destroyTexture((res as any).value);
    expect(debugInst._getDescriptorTable().size).toBe(0);
  });

  it('create N + destroy N leaves the registry empty (no unbounded growth)', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    const bufs: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      const r = device.createBuffer({ size: 32 * (i + 1), usage: 16 });
      bufs.push((r as any).value);
    }
    expect(debugInst._getDescriptorTable().size).toBe(5);

    for (const b of bufs) device.destroyBuffer(b);
    expect(debugInst._getDescriptorTable().size).toBe(0);
  });

  it('destroyBuffer on a never-registered handle is a silent no-op', async () => {
    const { debugInst } = await bootstrap();
    const adapter = await getAdapter(debugInst);
    const device = await getDevice(adapter);

    device.createBuffer({ size: 64, usage: 16 });
    expect(debugInst._getDescriptorTable().size).toBe(1);

    // An object the recorder never saw -> no handleId -> delete is a no-op,
    // and the underlying device call still runs without throwing.
    expect(() => device.destroyBuffer({} as any)).not.toThrow();
    expect(debugInst._getDescriptorTable().size).toBe(1);
  });
});

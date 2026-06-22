// ssao-buffers.test.ts — M1 / w3: SSAO buffer lazy-alloc test (TDD red phase).
//
// Asserts:
//  - getOrCreateSsaoBuffers first call creates kernel SSBO + noise texture
//    + SSAO uniform UBO (at least 3 createBuffer/createTexture calls).
//  - Second call returns same cached instance (0 new device calls).
//  - Labels match /^hdrp-ssao-/.
//  - storageBuffer=false path fires PostProcessError with code
//    'ssao-storage-buffer-unavailable' and returns null.
//
// AC-05 anchor: lazy alloc + hdrp-ssao-* labels + call-count assertions.

import type { Buffer, RhiCaps, RhiDevice, Texture } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import type { RenderSystemRuntime } from '../render-system';
import { getOrCreateSsaoBuffers } from '../ssao-buffers';

function mockTexture(label?: string): Texture {
  return { label: label ?? 'mock-tex' } as unknown as Texture;
}

function mockBuffer(label?: string): Buffer {
  return { label: label ?? 'mock-buf' } as unknown as Buffer;
}

function makeMockRuntime(capsOverride: Partial<RhiCaps> = {}): {
  runtime: RenderSystemRuntime;
  createBuffer: ReturnType<typeof vi.fn>;
  createTexture: ReturnType<typeof vi.fn>;
  createSampler: ReturnType<typeof vi.fn>;
} {
  const createBuffer = vi.fn().mockReturnValue({ ok: true, value: mockBuffer() });
  const createTexture = vi.fn().mockReturnValue({ ok: true, value: mockTexture() });
  const createSampler = vi.fn().mockReturnValue({ ok: true, value: { label: 'mock-sampler' } });

  const device = {
    caps: {
      backendKind: 'webgpu' as const,
      storageBuffer: true,
      float32Filterable: true,
      maxColorAttachments: 8,
      maxStorageBuffersPerShaderStage: 4,
      ...capsOverride,
    },
    createBuffer,
    createTexture,
    createSampler,
    queue: {
      writeBuffer: vi.fn().mockReturnValue({ ok: true, value: undefined }),
      writeTexture: vi.fn().mockReturnValue({ ok: true, value: undefined }),
    },
  } as unknown as RhiDevice;

  const errorRegistry = {
    fire: vi.fn(),
    listeners: new Set(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };

  const runtime = {
    device,
    errorRegistry,
  } as unknown as RenderSystemRuntime;

  return { runtime, createBuffer, createTexture, createSampler };
}

describe('getOrCreateSsaoBuffers', () => {
  it('first call creates kernel SSBO + noise texture + uniform UBO (>=3 GPU resources)', () => {
    const { runtime, createBuffer, createTexture } = makeMockRuntime();

    // The first call may createBuffer (kernel SSBO + uniform UBO)
    // + createTexture (noise), plus potentially a staging buffer
    const bufs = getOrCreateSsaoBuffers(runtime);

    expect(bufs).not.toBeNull();
    expect(bufs?.kernelBuffer).toBeDefined();
    expect(bufs?.kernelBytes).toBeGreaterThan(0);
    expect(bufs?.noiseTexture).toBeDefined();
    expect(bufs?.uniformBuffer).toBeDefined();
    expect(bufs?.uniformBytes).toBeGreaterThan(0);

    // At least 3 GPU resource creations: kernel SSBO, noise tex, uniform UBO.
    // Note: noise texture upload may require a staging buffer (extra createBuffer).
    const totalCalls = createBuffer.mock.calls.length + createTexture.mock.calls.length;
    expect(totalCalls).toBeGreaterThanOrEqual(3);
  });

  it('second call returns cached instance (0 new device calls)', () => {
    const { runtime, createBuffer, createTexture } = makeMockRuntime();

    const a = getOrCreateSsaoBuffers(runtime);
    expect(a).not.toBeNull();

    // Reset call counts AFTER first call
    const bufCallsAfterFirst = createBuffer.mock.calls.length;
    const texCallsAfterFirst = createTexture.mock.calls.length;

    const b = getOrCreateSsaoBuffers(runtime);

    // Same instance identity
    expect(b).toBe(a);

    // No additional device calls
    expect(createBuffer.mock.calls.length).toBe(bufCallsAfterFirst);
    expect(createTexture.mock.calls.length).toBe(texCallsAfterFirst);
  });

  it('kernel buffer label matches hdrp-ssao-kernel', () => {
    const { runtime, createBuffer } = makeMockRuntime();

    const calls: Array<Record<string, unknown>> = [];
    createBuffer.mockImplementation((desc: Record<string, unknown>) => {
      calls.push(desc);
      return { ok: true, value: mockBuffer() };
    });

    getOrCreateSsaoBuffers(runtime);

    const hasKernel = calls.some((c) => c.label === 'hdrp-ssao-kernel');
    expect(hasKernel).toBe(true);
  });

  it('SSAO uniform buffer label matches hdrp-ssao-uniform', () => {
    const { runtime, createBuffer } = makeMockRuntime();

    const calls: Array<Record<string, unknown>> = [];
    createBuffer.mockImplementation((desc: Record<string, unknown>) => {
      calls.push(desc);
      return { ok: true, value: mockBuffer() };
    });

    getOrCreateSsaoBuffers(runtime);

    const hasUniform = calls.some((c) => c.label === 'hdrp-ssao-uniform');
    expect(hasUniform).toBe(true);
  });

  it('noise texture label matches hdrp-ssao-noise', () => {
    const { runtime, createTexture } = makeMockRuntime();

    const calls: Array<Record<string, unknown>> = [];
    createTexture.mockImplementation((desc: Record<string, unknown>) => {
      calls.push(desc);
      return { ok: true, value: mockTexture() };
    });

    getOrCreateSsaoBuffers(runtime);

    const hasNoise = calls.some((c) => c.label === 'hdrp-ssao-noise');
    expect(hasNoise).toBe(true);
  });

  it('kernel buffer is 1024 bytes (64 vec3 as float32 x3 x4pad)', () => {
    const { runtime, createBuffer } = makeMockRuntime();

    const calls: Array<Record<string, unknown>> = [];
    createBuffer.mockImplementation((desc: Record<string, unknown>) => {
      calls.push(desc);
      return { ok: true, value: mockBuffer() };
    });

    getOrCreateSsaoBuffers(runtime);

    const kernelCall = calls.find((c) => c.label === 'hdrp-ssao-kernel');
    expect(kernelCall).toBeDefined();
    // 64 * 4 * 4 = 1024 bytes (4 floats per vec3 wgsl padded vec3 alignment)
    expect(kernelCall?.size).toBe(1024);
  });

  it('uniform buffer is 192 bytes (3 mat4)', () => {
    const { runtime, createBuffer } = makeMockRuntime();

    const calls: Array<Record<string, unknown>> = [];
    createBuffer.mockImplementation((desc: Record<string, unknown>) => {
      calls.push(desc);
      return { ok: true, value: mockBuffer() };
    });

    getOrCreateSsaoBuffers(runtime);

    const uniformCall = calls.find((c) => c.label === 'hdrp-ssao-uniform');
    expect(uniformCall).toBeDefined();
    // M7 round-2 D-C: 3 mat4 (192 B) + vec4 intensityPad padded to 256 B
    // for WebGPU UBO min binding offset alignment.
    expect(uniformCall?.size).toBe(256);
  });

  it('storageBuffer=false fires ssao-storage-buffer-unavailable error and returns null', () => {
    const { runtime, createBuffer, createTexture } = makeMockRuntime({
      storageBuffer: false,
    });

    const bufs = getOrCreateSsaoBuffers(runtime);

    expect(bufs).toBeNull();
    // No GPU resources allocated
    expect(createBuffer.mock.calls.length).toBe(0);
    expect(createTexture.mock.calls.length).toBe(0);
    // Round-2 [F-3]: storageBuffer=false fires PostProcessError exactly once
    // per runtime (warn-once). Reverts w16's silent-null-return regression
    // that violated requirements boundary case 4 + plan D-4 + charter P3.
    expect(runtime.errorRegistry.fire).toHaveBeenCalledTimes(1);
    const fired = (runtime.errorRegistry.fire as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as
      | { code?: string; detail?: { missingCap?: string } }
      | undefined;
    expect(fired?.code).toBe('ssao-storage-buffer-unavailable');
    expect(fired?.detail?.missingCap).toBe('storageBuffer');
  });

  it('storageBuffer=false subsequent calls do NOT re-fire (warn-once)', () => {
    const { runtime } = makeMockRuntime({ storageBuffer: false });

    expect(getOrCreateSsaoBuffers(runtime)).toBeNull();
    expect(getOrCreateSsaoBuffers(runtime)).toBeNull();
    expect(getOrCreateSsaoBuffers(runtime)).toBeNull();

    // warn-once: first call fires, subsequent calls do not re-fire.
    expect(runtime.errorRegistry.fire).toHaveBeenCalledTimes(1);
  });
});

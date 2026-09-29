import type { RhiInstance, ShaderModule } from '@forgeax/engine-rhi';
import { createShaderModule, rhi as nullRhi } from '@forgeax/engine-rhi-null';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { buildFrameModel } from '../frame-model';
import { decodeTape } from '../protocol/codec';
import { attachRecorder, type RecordableBackend } from '../recorder/session';

function backend(): RecordableBackend {
  const rhi = {
    requestAdapter: vi.fn(() => Promise.resolve({ ok: false as const, error: {} })),
  } as unknown as RhiInstance;
  return {
    rhi,
    createShaderModule: vi.fn(),
  };
}

describe('RecorderSession contract', () => {
  it('retains producer resource labels through the encoded tape and inspection model', async () => {
    const attachment = attachRecorder({ rhi: nullRhi, createShaderModule }).unwrap();
    const device = (
      await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()
    ).unwrap();
    const pending = attachment.captureFrame();
    (await attachment.frameBoundary()).unwrap();
    const buffer = device.createBuffer({ label: 'surface-rows', size: 1024, usage: 0x88 }).unwrap();
    const texture = device
      .createTexture({ label: 'surface-atlas', size: [4, 4], format: 'rgba8unorm', usage: 0x14 })
      .unwrap();
    const encoder = device.createCommandEncoder({}).unwrap();
    encoder.copyBufferToTexture(
      { buffer: buffer as unknown as GPUBuffer, bytesPerRow: 256, rowsPerImage: 4 },
      { texture: texture as unknown as GPUTexture },
      { width: 4, height: 4 },
    );
    device.queue.submit([encoder.finish().unwrap()]).unwrap();
    (await attachment.frameBoundary()).unwrap();
    const model = buildFrameModel(decodeTape((await pending).unwrap().bytes).unwrap());
    expect(
      model.resources
        .filter((resource) => resource.kind === 'buffer' || resource.kind === 'texture')
        .map((resource) => resource.descriptor),
    ).toEqual([
      expect.objectContaining({ desc: expect.objectContaining({ label: 'surface-rows' }) }),
      expect.objectContaining({ desc: expect.objectContaining({ label: 'surface-atlas' }) }),
    ]);
    device.destroyBuffer(buffer).unwrap();
    device.destroyTexture(texture).unwrap();
    (await attachment.dispose()).unwrap();
  });

  it('accepts one capture and rejects a concurrent request', async () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const capture = attached.value.captureFrame();
    const busy = await attached.value.captureFrame();
    expect(busy).toMatchObject({ ok: false, error: { code: 'capture-busy' } });

    await attached.value.frameBoundary();
    await attached.value.frameBoundary();
    const result = await capture;
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.bytes.byteLength).toBeGreaterThan(0);
  });

  it('does not retain frame work before capture is armed', () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    expect('getEvents' in attached.value.backend.rhi).toBe(false);
    expect('getBlobPool' in attached.value.backend.rhi).toBe(false);
  });

  it('keeps the wrapped shader factory on the explicit RHI singleton', () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    expect(
      (attached.value.backend.rhi as unknown as { createShaderModule: unknown }).createShaderModule,
    ).toBe(attached.value.backend.createShaderModule);
  });

  it('preserves the optional immediate shader factory on both backend seams', () => {
    const createShaderModuleImmediate = vi.fn(() => ok({} as ShaderModule));
    const attached = attachRecorder({ ...backend(), createShaderModuleImmediate });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    expect(attached.value.backend.createShaderModuleImmediate).toBeDefined();
    expect(
      (
        attached.value.backend.rhi as unknown as {
          createShaderModuleImmediate?: unknown;
        }
      ).createShaderModuleImmediate,
    ).toBe(attached.value.backend.createShaderModuleImmediate);
  });

  it('resolves an abort as one terminal structured result', async () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const controller = new AbortController();
    const capture = attached.value.captureFrame({ signal: controller.signal });
    controller.abort();
    const result = await capture;
    expect(result).toMatchObject({ ok: false, error: { code: 'capture-unavailable' } });
    expect((await attached.value.frameBoundary()).ok).toBe(true);
  });
});

it('cannot settle a newer capture when an aborted snapshot finishes late', async () => {
  const adapter = (await nullRhi.requestAdapter()).unwrap();
  const device = (await adapter.requestDevice()).unwrap();
  let release: (() => void) | undefined;
  const drain = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  vi.spyOn(device.queue, 'onSubmittedWorkDone').mockImplementationOnce(() => drain);
  const attachment = attachRecorder({
    createShaderModule,
    rhi: {
      ...nullRhi,
      requestAdapter: async () => ok({ ...adapter, requestDevice: async () => ok(device) }),
    },
  }).unwrap();
  (await (await attachment.backend.rhi.requestAdapter()).unwrap().requestDevice()).unwrap();
  const controller = new AbortController();
  const first = attachment.captureFrame({ signal: controller.signal });
  const oldBoundary = attachment.frameBoundary();
  controller.abort();
  expect((await first).ok).toBe(false);
  const retry = attachment.captureFrame();
  release?.();
  await oldBoundary;
  (await attachment.frameBoundary()).unwrap();
  (await attachment.frameBoundary()).unwrap();
  expect((await retry).ok).toBe(true);
  (await attachment.dispose()).unwrap();
});

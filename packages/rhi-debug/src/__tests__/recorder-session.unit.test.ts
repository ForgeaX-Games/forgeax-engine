import type { RhiInstance } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
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

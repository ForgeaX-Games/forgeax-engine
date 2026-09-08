import type { RhiInstance } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { attachRecorder, type RecordableBackend } from '../recorder/session';

function backend(): RecordableBackend {
  return {
    rhi: {
      requestAdapter: vi.fn(() => Promise.resolve({ ok: false as const, error: {} })),
    } as unknown as RhiInstance,
    createShaderModule: vi.fn(),
  };
}

describe('RecorderSession bounded options', () => {
  it('fails before snapshot allocation when the byte budget is exhausted', async () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const capture = attached.value.captureFrame({ byteBudget: 0 });
    const boundary = await attached.value.frameBoundary();
    expect(boundary).toMatchObject({ ok: false, error: { code: 'capture-snapshot-failed' } });
    expect(await capture).toMatchObject({ ok: false, error: { code: 'capture-snapshot-failed' } });

    const retry = attached.value.captureFrame();
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    await attached.value.frameBoundary();
    expect((await retry).ok).toBe(true);
  });

  it('keeps timeout and budget as bounded options instead of frame-count controls', async () => {
    const attached = attachRecorder(backend());
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const options = { snapshotTimeoutMs: 1, byteBudget: 1024 };
    const capture = attached.value.captureFrame(options);
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    await attached.value.frameBoundary();
    expect((await capture).ok).toBe(true);
  });
});

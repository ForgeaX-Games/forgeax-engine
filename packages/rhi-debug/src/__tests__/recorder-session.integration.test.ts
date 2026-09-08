import { createShaderModule, rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { attachRecorder } from '../index';
import { decodeTape } from '../protocol/codec';

describe('RecorderSession real RHI consumer', () => {
  it('captures one steady frame into a strict v7 artifact', async () => {
    const attached = attachRecorder({ rhi, createShaderModule });
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const adapter = await attached.value.backend.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) return;

    const capture = attached.value.captureFrame();
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    const result = await capture;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decodeTape(result.value.bytes);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.header.formatVersion).toBe(7);
    expect(decoded.value.header.eventCount).toBe(1);
    expect(decoded.value.events[0]?.kind).toBe('frameMark');
  });
});

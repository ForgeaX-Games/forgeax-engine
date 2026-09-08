/// <reference types="@webgpu/types" />

import { describe, expect, it } from 'vitest';
import { decodeTape } from '../protocol/codec';
import { attachRecorder, type RecordableBackend } from '../recorder/session';

async function dawnBackend(): Promise<RecordableBackend> {
  return (await import('@forgeax/engine-rhi-webgpu')) as unknown as RecordableBackend;
}

describe('RecorderSession steady-frame Dawn contract', () => {
  it('captures a resource created and uploaded before the requested frame', async () => {
    const backend = await dawnBackend();
    const attached = attachRecorder(backend);
    expect(attached.ok).toBe(true);
    if (!attached.ok) return;

    const adapter = await attached.value.backend.rhi.requestAdapter();
    expect(adapter.ok).toBe(true);
    if (!adapter.ok) return;
    const device = await adapter.value.requestDevice();
    expect(device.ok).toBe(true);
    if (!device.ok) return;
    const buffer = device.value.createBuffer({ size: 16, usage: 0x28 });
    expect(buffer.ok).toBe(true);
    if (!buffer.ok) return;
    const write = device.value.queue.writeBuffer(buffer.value, 0, new Uint8Array(16));
    expect(write.ok).toBe(true);

    const capture = attached.value.captureFrame();
    expect((await attached.value.frameBoundary()).ok).toBe(true);
    const encoder = device.value.createCommandEncoder({});
    expect(encoder.ok).toBe(true);
    if (!encoder.ok) return;
    encoder.value.clearBuffer(buffer.value, 0, 16);
    const command = encoder.value.finish();
    expect(command.ok).toBe(true);
    if (!command.ok) return;
    const submit = device.value.queue.submit([command.value]);
    expect(submit.ok).toBe(true);
    expect((await attached.value.frameBoundary()).ok).toBe(true);

    const result = await capture;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decoded = decodeTape(result.value.bytes);
    if (!decoded.ok)
      throw new Error(`${decoded.error.code}: ${JSON.stringify(decoded.error.detail)}`);
    expect(decoded.value.bootstrap.some((resource) => resource.kind === 'buffer')).toBe(true);
    expect(decoded.value.events.some((event) => event.kind === 'clearBuffer')).toBe(true);
  });
});

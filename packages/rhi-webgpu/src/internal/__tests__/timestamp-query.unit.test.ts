import { RhiError } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { createMockGpu } from '../../__tests__/__mocks__/gpu-device';
import { makeRhiDevice } from '../../device';

async function timestampEncoder(writeTimestamp?: (querySet: unknown, queryIndex: number) => void) {
  const gpu = createMockGpu();
  const adapter = await gpu.requestAdapter();
  if (adapter === null) throw new Error('mock adapter should exist');
  const raw = await adapter.requestDevice();
  const features = raw.features as unknown as Set<GPUFeatureName>;
  features.add('timestamp-query');
  const originalCreateCommandEncoder = raw.createCommandEncoder.bind(raw);
  raw.createCommandEncoder = (descriptor) => {
    const encoder = originalCreateCommandEncoder(descriptor) as unknown as Record<string, unknown>;
    if (writeTimestamp !== undefined) encoder.writeTimestamp = writeTimestamp;
    return encoder as unknown as ReturnType<typeof raw.createCommandEncoder>;
  };
  const { device } = makeRhiDevice(raw as unknown as GPUDevice);
  const querySet = device.createQuerySet({ type: 'timestamp', count: 2 });
  if (!querySet.ok) throw new Error('timestamp query set should be created');
  const encoder = device.createCommandEncoder();
  if (!encoder.ok) throw new Error('command encoder should be created');
  return { encoder: encoder.value, querySet: querySet.value };
}

describe('timestamp query raw write seam', () => {
  it('forwards a callable raw writeTimestamp exactly once', async () => {
    const calls: Array<{ querySet: unknown; queryIndex: number }> = [];
    const { encoder, querySet } = await timestampEncoder((rawQuerySet, queryIndex) => {
      calls.push({ querySet: rawQuerySet, queryIndex });
    });

    encoder.writeTimestamp(querySet, 1);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.querySet).toBeDefined();
    expect(calls[0]?.queryIndex).toBe(1);
  });

  it('returns a structured refusal when capability-positive raw writeTimestamp is missing', async () => {
    const { encoder, querySet } = await timestampEncoder();

    expect(() => encoder.writeTimestamp(querySet, 0)).toThrow(RhiError);
    try {
      encoder.writeTimestamp(querySet, 0);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'webgpu-runtime-error',
        expected: 'underlying GPUCommandEncoder.writeTimestamp to be callable',
      });
      expect((error as RhiError).hint).toContain('timestamp-query');
    }
  });

  it('returns a structured refusal when raw writeTimestamp throws', async () => {
    const { encoder, querySet } = await timestampEncoder(() => {
      throw new Error('raw timestamp failure');
    });

    expect(() => encoder.writeTimestamp(querySet, 0)).toThrow(RhiError);
    try {
      encoder.writeTimestamp(querySet, 0);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'webgpu-runtime-error',
        expected: 'underlying GPUCommandEncoder.writeTimestamp to succeed',
      });
      expect((error as RhiError).hint).toContain('raw timestamp failure');
    }
  });

  it('refuses timestamp writes after encoder.finish with a lifecycle error', async () => {
    const { encoder, querySet } = await timestampEncoder(() => {});
    const finish = encoder.finish();
    expect(finish.ok).toBe(true);

    expect(() => encoder.writeTimestamp(querySet, 0)).toThrow(RhiError);
    try {
      encoder.writeTimestamp(querySet, 0);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'command-encoder-finished',
        expected: 'command encoder must not be finished before recording new commands',
      });
    }
  });
});

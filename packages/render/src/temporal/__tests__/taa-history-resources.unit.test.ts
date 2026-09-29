import type { RhiDevice } from '@forgeax/engine-rhi';
import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { createTaaHistoryResources, type TaaHistoryResources } from '../taa-history-resources';

async function nullDevice(): Promise<RhiDevice> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw adapter.error;
  const device = await adapter.value.requestDevice();
  if (!device.ok) throw device.error;
  return device.value;
}

describe('TAA GPU history resources', () => {
  it('allocates two rgba16float slots with sampled/render/copy usage', async () => {
    const device = await nullDevice();
    const resources = createTaaHistoryResources(device, 64, 32);
    expect(resources.ok).toBe(true);
    if (!resources.ok) return;
    expect(resources.value.slots).toHaveLength(2);
    expect(resources.value.descriptor.format).toBe('rgba16float');
    expect(resources.value.descriptor.usage).toBe(0x17);
    resources.value.dispose();
  });

  it('swaps only on commit and preserves the previous slot on abort', async () => {
    const device = await nullDevice();
    const resources = createTaaHistoryResources(device, 8, 8);
    expect(resources.ok).toBe(true);
    if (!resources.ok) return;
    const state: TaaHistoryResources = resources.value;
    expect(state.previousIndex).toBe(1);
    expect(state.valid).toBe(false);
    state.beginFrame();
    state.abortFrame();
    expect(state.currentIndex).toBe(0);
    expect(state.valid).toBe(false);
    state.beginFrame();
    state.commitFrame();
    expect(state.currentIndex).toBe(1);
    expect(state.previousIndex).toBe(0);
    expect(state.valid).toBe(true);
    state.dispose();
  });
});

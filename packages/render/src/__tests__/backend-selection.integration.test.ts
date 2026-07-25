import { rhi } from '@forgeax/engine-rhi-null';
import { describe, expect, it } from 'vitest';
import { loadBackendPack } from '../renderer/backend-selection';

describe('backend selection', () => {
  it('uses an explicitly injected backend without probing global state', async () => {
    const result = await loadBackendPack({ rhi });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.rhi).toBe(rhi);
  });
});

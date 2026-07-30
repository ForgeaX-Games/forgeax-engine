import { describe, expect, it, vi } from 'vitest';
import { LoaderRegistry, type PackLoaderInput } from '../loader-registry';

const input: PackLoaderInput = {
  guid: '11111111-1111-4111-8111-111111111111',
  kind: 'host-blob',
  payload: { value: 1 },
  refs: [],
  artifacts: {
    source: {
      descriptor: { path: 'source.bin', mediaType: 'application/octet-stream' },
      bytes: Uint8Array.of(1, 2),
    },
  },
};

describe('uniform Pack v2 loader input', () => {
  it('contains asset-local artifacts and no catalog transport facts', () => {
    expect(input.artifacts.source?.bytes).toEqual(Uint8Array.of(1, 2));
    expect(input).not.toHaveProperty('packageUrl');
    expect(input).not.toHaveProperty('packageUrl');
  });

  it('dispatches one uniform input to the registered kind loader', async () => {
    const load = vi.fn().mockResolvedValue({ ok: true, value: { kind: 'host-blob' } });
    const registry = new LoaderRegistry();
    registry.registerPackLoader({ kind: 'host-blob', load });
    const result = await registry.loadPack(input, {} as never);
    expect(result.ok).toBe(true);
    expect(load).toHaveBeenCalledWith(input, {});
  });
});

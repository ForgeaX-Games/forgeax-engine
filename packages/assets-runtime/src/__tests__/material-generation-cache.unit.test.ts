import { describe, expect, it } from 'vitest';
import { MaterialGenerationCache } from '../material/generation-cache.js';

describe('material generation cache', () => {
  it('reuses promises by material GUID and artifacts by specialization key', async () => {
    const cache = new MaterialGenerationCache();
    const first = cache.resolve('mat-a', 'key-a', async () => ({ value: 1 }));
    const second = cache.resolve('mat-a', 'key-a', async () => ({ value: 2 }));

    expect(first).toBe(second);
    await expect(first).resolves.toEqual({ value: 1 });
    cache.storeArtifact('key-a', Object.freeze({ bytes: new Uint8Array([1]) }));
    expect(cache.getArtifact('key-a')).toEqual({ bytes: new Uint8Array([1]) });
  });

  it('allows distinct authored GUIDs to share one artifact', () => {
    const cache = new MaterialGenerationCache();
    const artifact = Object.freeze({ bytes: new Uint8Array([1]) });

    cache.storeArtifact('key-a', artifact);
    cache.linkResolved('mat-a', 'key-a');
    cache.linkResolved('mat-b', 'key-a');

    expect(cache.getResolvedKey('mat-a')).toBe('key-a');
    expect(cache.getResolvedKey('mat-b')).toBe('key-a');
    expect(cache.getArtifact('key-a')).toBe(artifact);
  });
});

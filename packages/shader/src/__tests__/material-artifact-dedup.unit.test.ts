import { describe, expect, it } from 'vitest';
import { MaterialArtifactRegistry } from '../material/artifact-registry.js';

describe('material artifact deduplication', () => {
  it('shares immutable artifacts by specialization key and rejects conflicts', () => {
    const registry = new MaterialArtifactRegistry();
    const first = Object.freeze({ key: 'key-a', bytes: new Uint8Array([1]) });
    const second = Object.freeze({ key: 'key-a', bytes: new Uint8Array([2]) });

    expect(registry.register(first)).toEqual({ ok: true, value: first });
    expect(registry.register({ key: 'key-a', bytes: new Uint8Array([1]) })).toEqual({
      ok: true,
      value: first,
    });
    expect(registry.register(second)).toMatchObject({
      ok: false,
      error: { code: 'material-artifact-conflict' },
    });
    expect(registry.get('key-a')).toBe(first);
  });
});

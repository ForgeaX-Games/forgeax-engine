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

  it('rejects an ABI receipt change when artifact bytes and parameters are unchanged', () => {
    const registry = new MaterialArtifactRegistry();
    const first = {
      key: 'key-receipt',
      bytes: new Uint8Array([1]),
      metadata: { paramSchema: [], receipt: { receiptIdentity: 'plain' } },
    };
    expect(registry.register(first)).toMatchObject({ ok: true });
    expect(
      registry.register({
        key: first.key,
        bytes: new Uint8Array([1]),
        metadata: { paramSchema: [], receipt: { receiptIdentity: 'colored' } },
      }),
    ).toMatchObject({
      ok: false,
      error: { detail: { dimension: 'receipt' } },
    });
  });
});

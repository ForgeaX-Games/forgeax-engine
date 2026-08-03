import { describe, expect, it } from 'vitest';
import { NativeCookerRegistry } from '../native-cooker-registry.js';

describe('NativeCookerRegistry artifact boundary', () => {
  it('keeps native artifact bytes available before converting to CookProduct descriptors', async () => {
    const bytes = new TextEncoder().encode('{"program":true}');
    const registry = new NativeCookerRegistry();
    registry.register({
      key: 'test-effect',
      cook: () => ({
        guid: '019e9c00-0000-7000-8000-000000000000',
        payload: { kind: 'test-effect' },
        refs: ['019e9c00-0000-7000-8000-000000000001'],
        artifacts: {
          'test-effect/program.json': { mediaType: 'application/json', bytes },
        },
        inputFingerprint: 'sha256:test-input',
      }),
    });

    const draft = await registry.runDraft('test-effect', {});
    expect(draft.ok).toBe(true);
    if (!draft.ok) throw new Error(draft.error.hint);
    expect(draft.value.artifacts['test-effect/program.json']?.bytes).toEqual(bytes);

    const product = await registry.run('test-effect', {});
    expect(product.ok).toBe(true);
    if (!product.ok) throw new Error(product.error.hint);
    expect(product.value.artifacts['test-effect/program.json']).toMatchObject({
      path: 'test-effect/program.json',
      mediaType: 'application/json',
      byteLength: bytes.byteLength,
    });
  });
});

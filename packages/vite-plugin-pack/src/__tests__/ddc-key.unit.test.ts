import { describe, expect, it } from 'vitest';
import { semanticDdcKey } from '../ddc-cache.js';

const input = () => ({
  schemaVersion: '2.0.0',
  importerVersion: 'image@1',
  codecVersion: 'codec@2',
  sourceDependencies: [{ path: 'assets/a.png', digest: 'aaa' }],
  settings: { colorSpace: 'srgb', mipmap: true },
  declaredGuids: ['019e3969-1d48-7c3b-ac24-6d68f457065f'],
  cookProfile: 'release',
  publish: { base: '/preview/', url: 'assets/a.bin', hash: 'hash-a' },
});

describe('semantic DDC key', () => {
  it('includes every semantic input and excludes publish environment', () => {
    const a = semanticDdcKey(input());
    const b = semanticDdcKey({ ...input(), publish: { base: '/release/', url: 'x', hash: 'y' } });
    expect(a).toBe(b);
    expect(semanticDdcKey({ ...input(), codecVersion: 'codec@3' })).not.toBe(a);
    expect(
      semanticDdcKey({ ...input(), settings: { colorSpace: 'linear', mipmap: true } }),
    ).not.toBe(a);
    expect(
      semanticDdcKey({ ...input(), sourceDependencies: [{ path: 'assets/a.png', digest: 'bbb' }] }),
    ).not.toBe(a);
  });

  it('is stable for object insertion order and GUID order', () => {
    const a = semanticDdcKey(input());
    const b = semanticDdcKey({
      ...input(),
      settings: { mipmap: true, colorSpace: 'srgb' },
      declaredGuids: [...input().declaredGuids].reverse(),
    });
    expect(a).toBe(b);
  });

  it('does not use path or publish fields as semantic identity', () => {
    const a = semanticDdcKey(input());
    const b = semanticDdcKey({
      ...input(),
      sourceDependencies: [{ path: 'moved/a.png', digest: 'aaa' }],
      publish: { base: '/other/', url: 'other/a.bin', hash: 'other-hash' },
    });
    expect(a).toBe(b);
  });
});

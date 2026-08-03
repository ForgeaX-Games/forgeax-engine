import { describe, expect, it } from 'vitest';
import { type SemanticDdcInput, semanticDdcKey } from '../key.js';

const baseInput = (): SemanticDdcInput => ({
  schemaVersion: 'asset-pack@2',
  importer: 'image@4',
  codec: 'basis@3',
  settings: { colorSpace: 'srgb', mipmap: true },
  sourceBytes: [new Uint8Array([1, 2, 3, 4])],
  declaredGuids: ['019e3969-1d48-7c3b-ac24-6d68f457065f'],
  targetProfile: 'webgpu-release',
  producer: 'image-importer@4',
});

describe('semantic DDC key', () => {
  it('is deterministic for equal semantic inputs', () => {
    expect(semanticDdcKey(baseInput())).toBe(semanticDdcKey(baseInput()));
  });

  it('does not include author path or publication environment', () => {
    const input = baseInput();
    const moved = { ...input, sourceBytes: [new Uint8Array([1, 2, 3, 4])] };
    expect(semanticDdcKey(input)).toBe(semanticDdcKey(moved));
  });

  it.each([
    ['schemaVersion', { schemaVersion: 'asset-pack@3' }],
    ['importer', { importer: 'image@5' }],
    ['codec', { codec: 'basis@4' }],
    ['settings', { settings: { colorSpace: 'linear', mipmap: true } }],
    ['sourceBytes', { sourceBytes: [new Uint8Array([1, 2, 3, 5])] }],
    ['declaredGuids', { declaredGuids: ['019e3969-1d48-7c3b-ac24-6d68f457065e'] }],
    ['targetProfile', { targetProfile: 'webgpu-debug' }],
    ['producer', { producer: 'image-importer@5' }],
  ])('misses when %s changes', (_name, change) => {
    expect(semanticDdcKey({ ...baseInput(), ...change })).not.toBe(semanticDdcKey(baseInput()));
  });

  it('canonicalizes object and GUID ordering without changing the digest', () => {
    const input = baseInput();
    expect(
      semanticDdcKey({
        ...input,
        settings: { mipmap: true, colorSpace: 'srgb' },
        declaredGuids: [...input.declaredGuids].reverse(),
      }),
    ).toBe(semanticDdcKey(input));
  });
});

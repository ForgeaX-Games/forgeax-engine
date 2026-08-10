import { describe, expect, it } from 'vitest';
import {
  isCurrentSourcePackageDdc,
  type SourcePackageDdcInput,
  sourcePackageDdcKey,
} from '../producer/source-package-publication.js';

const GUID_A = '019e3969-1d48-7c3b-ac24-6d68f457065f';
const GUID_B = '019e3969-1d48-7c3b-ac24-6d68f4570660';

function input(overrides: Partial<SourcePackageDdcInput> = {}): SourcePackageDdcInput {
  return {
    schemaVersion: 'source-package-v1',
    importer: 'gltf',
    importerVersion: 'gltf@4',
    producerFingerprint: 'sha256:producer-a',
    codec: 'pack-v2',
    settings: { colorSpace: 'srgb', mipmap: 'auto' },
    sourceDependencies: [
      { path: 'scene.gltf', digest: 'sha256:source-a' },
      { path: 'scene.bin', digest: 'sha256:buffer-a' },
    ],
    declaredGuids: [GUID_A, GUID_B],
    targetProfile: 'dev',
    publish: { base: '/', packagePath: '/__forgeax-ddc/a.pack.json' },
    ...overrides,
  };
}

describe('source package semantic DDC identity', () => {
  it('keeps the key stable when declaration and dependency order changes', () => {
    const first = input();
    const reordered = input({
      declaredGuids: [GUID_B, GUID_A],
      sourceDependencies: [...first.sourceDependencies].reverse(),
    });

    expect(sourcePackageDdcKey(first)).toBe(sourcePackageDdcKey(reordered));
  });

  it.each([
    ['a source digest', { sourceDependencies: [{ path: 'scene.gltf', digest: 'sha256:changed' }] }],
    ['settings', { settings: { colorSpace: 'linear', mipmap: 'auto' } }],
    ['declared GUID set', { declaredGuids: [GUID_A] }],
    ['importer version', { importerVersion: 'gltf@5' }],
    ['producer fingerprint', { producerFingerprint: 'sha256:producer-b' }],
    ['cook profile', { targetProfile: 'production' }],
  ])('invalidates reuse when %s changes', (_label, change) => {
    expect(sourcePackageDdcKey(input())).not.toBe(sourcePackageDdcKey(input(change)));
  });

  it('does not treat publication paths as semantic identity', () => {
    expect(sourcePackageDdcKey(input())).toBe(
      sourcePackageDdcKey(
        input({
          publish: { base: '/preview/', packagePath: '/hashed/other.pack.json' },
        }),
      ),
    );
  });

  it('revalidates the recorded source dependency digests after restart', () => {
    const current = input();
    const record = { key: sourcePackageDdcKey(current), input: current };

    expect(isCurrentSourcePackageDdc(record, current)).toBe(true);
    expect(
      isCurrentSourcePackageDdc(record, {
        ...current,
        sourceDependencies: current.sourceDependencies.map((dependency) =>
          dependency.path === 'scene.bin' ? { ...dependency, digest: 'sha256:stale' } : dependency,
        ),
      }),
    ).toBe(false);
  });
});

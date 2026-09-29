import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { readShaderManifestPublication } from '../manifest-publication.js';

const wgsl = 'fn main() {}\n';
const digest = createHash('sha256').update(wgsl).digest('hex');

function publication() {
  return {
    schemaVersion: '2.0.0',
    fragments: ['fn main() {}\n'],
    sources: { [digest]: [0] },
    entries: [{ hash: 'a', bindings: '[]', sourceDigest: digest }],
    materialShaders: [
      {
        identifier: 'material',
        sourcePath: 'material.wgsl',
        paramSchema: '[]',
        sourceDigest: digest,
        variants: [{ definesKey: '', defines: {}, sourceDigest: digest }],
      },
    ],
  };
}

describe('shader publication admission', () => {
  it('restores exact WGSL into program and material rows', async () => {
    expect(await readShaderManifestPublication(publication())).toEqual({
      entries: [{ hash: 'a', bindings: '[]', wgsl }],
      materialShaders: [
        {
          identifier: 'material',
          sourcePath: 'material.wgsl',
          paramSchema: '[]',
          composedWgsl: wgsl,
          variants: [{ definesKey: '', defines: {}, composedWgsl: wgsl }],
        },
      ],
    });
  });

  it('rejects corrupted bytes and missing source refs before publication', async () => {
    const corrupted = publication();
    corrupted.fragments[0] = 'fn main() { broken }\n';
    await expect(readShaderManifestPublication(corrupted)).rejects.toThrow('digest mismatch');
    const missing = publication();
    const first = missing.entries[0];
    if (first === undefined) throw new Error('missing fixture entry');
    first.sourceDigest = '0'.repeat(64);
    await expect(readShaderManifestPublication(missing)).rejects.toThrow('missing or unused');
  });

  it('checks the complete source table including corruption after the first batch', async () => {
    const fragments = Array.from({ length: 35 }, (_, i) => `fn shader_${i}() {}\n`);
    const digests = fragments.map((source) => createHash('sha256').update(source).digest('hex'));
    const value = {
      schemaVersion: '2.0.0',
      fragments,
      sources: Object.fromEntries(digests.map((hash, i) => [hash, [i]])),
      entries: digests.map((sourceDigest, i) => ({
        hash: String(i),
        bindings: '[]',
        sourceDigest,
      })),
      materialShaders: [],
    };
    expect(await readShaderManifestPublication(value)).toEqual({
      entries: fragments.map((source, i) => ({ hash: String(i), bindings: '[]', wgsl: source })),
      materialShaders: [],
    });
    for (const index of [0, 16, 34]) {
      const corrupt = [...fragments];
      corrupt[index] += '// modified';
      await expect(readShaderManifestPublication({ ...value, fragments: corrupt })).rejects.toThrow(
        `Shader source digest mismatch: ${digests[index]}`,
      );
    }
  });
});

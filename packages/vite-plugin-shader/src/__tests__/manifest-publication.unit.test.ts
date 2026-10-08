import {
  expandShaderManifestPublication,
  readShaderManifestPublication,
} from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { publishShaderManifest } from '../manifest-publication.js';

describe('shared shader source publication', () => {
  it('reuses admitted source blocks while publishing fresh variants and removing old sources', async () => {
    const retained = 'fn common() {}\n\nfn retained() {}\n';
    const removed = 'fn removed() {}\n';
    const fresh = 'fn common() {}\n\nfn fresh() {}\n';
    const previous = publishShaderManifest(
      [
        { hash: 'retained', wgsl: retained },
        { hash: 'removed', wgsl: removed },
      ],
      [],
    );
    const expanded = expandShaderManifestPublication(previous);
    const blocks = new Map(
      [...expanded.sources].map(([digest, source]) => [
        source,
        (previous.sources[digest] ?? []).map((index) => previous.fragments[index] ?? ''),
      ]),
    );
    const original = {
      entries: [{ hash: 'retained', wgsl: retained, bindings: '[]' }],
      materialShaders: [
        {
          identifier: 'fresh',
          composedWgsl: fresh,
          variants: [{ definesKey: 'A=true', defines: { A: true }, composedWgsl: retained }],
        },
      ],
    };
    const split = String.prototype.split;
    const divided: string[] = [];
    const spy = vi.spyOn(String.prototype, 'split').mockImplementation(function (
      this: string,
      separator: unknown,
      limit?: number,
    ) {
      if (separator === '\n\n') divided.push(String(this));
      return Reflect.apply(split, this, [separator, limit]) as string[];
    });
    const publication = (() => {
      try {
        return publishShaderManifest(original.entries, original.materialShaders, blocks);
      } finally {
        spy.mockRestore();
      }
    })();
    expect(divided).toEqual([fresh]);
    expect(await readShaderManifestPublication(publication)).toEqual(original);
    expect(Object.keys(publication.sources)).toHaveLength(2);
    expect(publication.fragments.join('')).not.toContain('fn removed()');
  });

  it('rejects reused fragments that do not reproduce the keyed source', () => {
    const source = 'fn retained() {}';
    expect(() =>
      publishShaderManifest(
        [{ hash: 'test', wgsl: source }],
        [],
        new Map([[source, ['fn corrupted() {}']]]),
      ),
    ).toThrow('do not match admitted bytes');
  });

  it('retains separators, CRLF and the final unterminated source bytes', async () => {
    const wgsl = '\n\n// prefix\r\n\r\nfn main() {}\n\n\n// tail  ';
    const entries = [{ hash: 'test', wgsl }];
    const publication = publishShaderManifest(entries, []);
    expect(await readShaderManifestPublication(publication)).toEqual({
      entries,
      materialShaders: [],
    });
  });

  it('bounds the source table for many variants sharing a long WGSL declaration', () => {
    const common = `fn shared() {\n${Array.from({ length: 1000 }, (_, index) => `  let value_${index} = ${index}u;\n`).join('')}}\n\n`;
    const variants = Array.from({ length: 16 }, (_, index) => ({
      definesKey: `MODE=${index}`,
      composedWgsl: `${common}fn main() { let mode = ${index}u; }\n`,
    }));
    const published = publishShaderManifest(
      [],
      [{ composedWgsl: `${common}fn main() { let mode = 0u; }\n`, variants }],
    );
    // A repeated function must not turn each variant into another per-line index stream.
    expect(JSON.stringify(published).length).toBeLessThan(common.length * 2);
    expect([...expandShaderManifestPublication(published).sources.values()].sort()).toEqual(
      variants.map((variant) => variant.composedWgsl).sort(),
    );
  });

  it('preserves variant identity and exact source bytes across shared blocks', () => {
    const common = Array.from({ length: 30 }, (_, index) => `fn shared_${index}() {}\n\n`).join('');
    const first = `${common}fn main() { let x = 1; }\n`;
    const second = `${common}fn main() { let x = 2; }\n`;
    const original = {
      entries: [{ hash: 'primary', wgsl: first, bindings: '[]' }],
      materialShaders: [
        {
          identifier: 'material',
          composedWgsl: first,
          variants: [
            { definesKey: 'A=false', defines: { A: false }, composedWgsl: second },
            { definesKey: 'A=true', defines: { A: true }, composedWgsl: first },
          ],
        },
      ],
    };
    const published = publishShaderManifest(original.entries, original.materialShaders);
    expect(published.schemaVersion).toBe('2.0.0');
    expect(published.entries[0]).toMatchObject({
      hash: 'primary',
      sourceDigest: published.materialShaders[0]?.sourceDigest,
    });
    expect(published.materialShaders[0]?.variants[1]?.sourceDigest).toBe(
      published.entries[0]?.sourceDigest,
    );
    expect(Object.keys(published.sources)).toHaveLength(2);
    expect(expandShaderManifestPublication(published).manifest).toEqual(original);
    expect(JSON.stringify(published).length).toBeLessThan(JSON.stringify(original).length);
  });
});

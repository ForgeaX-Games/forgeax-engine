import { readFileSync } from 'node:fs';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CompressArtifactOpts } from '../compress-artifact.js';

type ArtifactKind = CompressArtifactOpts['kind'];

const ownerSource = readFileSync(new URL('../compress-artifact.ts', import.meta.url), 'utf8');

describe('compress-artifact ArtifactKind owner', () => {
  it('derives the exact mesh/texture membership from STRATEGY_TABLE', () => {
    expectTypeOf<ArtifactKind>().toEqualTypeOf<'mesh' | 'texture'>();
    expectTypeOf<'mesh'>().toExtend<ArtifactKind>();
    expectTypeOf<'texture'>().toExtend<ArtifactKind>();
    expectTypeOf<'unknown'>().not.toExtend<ArtifactKind>();
  });

  it('keeps the declaration derived from the strategy table', () => {
    expect(ownerSource).toContain('const STRATEGY_TABLE = {');
    expect(ownerSource).toContain('} satisfies Record<string, AssetCompression>;');
    expect(ownerSource).toContain('type ArtifactKind = keyof typeof STRATEGY_TABLE;');
  });
});

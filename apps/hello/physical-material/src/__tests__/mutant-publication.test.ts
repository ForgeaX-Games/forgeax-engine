import { createHash } from 'node:crypto';
import { readShaderManifestPublication } from '@forgeax/engine-shader';
import { expect, it } from 'vitest';
// @ts-expect-error browser-safe evidence module is intentionally JavaScript.
import { createAdditiveCoatMutantPublication } from '../../evidence/additive-coat-mutant.mjs';

function publication(source: string) {
  const sourceDigest = createHash('sha256').update(source).digest('hex');
  const row = { sourceDigest, defines: {}, definesKey: '' };
  return {
    schemaVersion: '2.0.0',
    fragments: [source],
    sources: { [sourceDigest]: [0] },
    entries: [],
    materialShaders: [{ ...row, identifier: 'product', variants: [row] }],
  };
}

it('produces a digest-valid additive falsifier from the current fragmented wire publication', async () => {
  const input = publication('evaluateClearcoatLayer(); let attenuatedBase = (baseRadiance * (1f - _e2));');
  const original = structuredClone(input);
  const mutant = await createAdditiveCoatMutantPublication(input, 'product', 'mutant');
  expect(input).toEqual(original);
  expect(mutant.materialShaders[0]).toEqual(input.materialShaders[0]);
  expect(mutant.materialShaders[1].composedWgsl).toBeUndefined();
  const admitted = await readShaderManifestPublication(mutant) as {
    materialShaders: Array<{ identifier: string; composedWgsl: string; variants: Array<{ composedWgsl: string }> }>;
  };
  const admittedMutant = admitted.materialShaders[1]!;
  expect(admittedMutant.identifier).toBe('mutant');
  expect(admittedMutant.composedWgsl).toContain('let attenuatedBase = baseRadiance;');
  expect(admittedMutant.variants[0]!.composedWgsl).toBe(admittedMutant.composedWgsl);

  const replaced = await createAdditiveCoatMutantPublication(input, 'product', 'product');
  expect(replaced.materialShaders).toHaveLength(1);
  expect(Object.keys(replaced.sources)).toHaveLength(1);
  await expect(readShaderManifestPublication(replaced)).resolves.toBeDefined();
});

it('rejects a no-effect mutant instead of weakening the energy falsifier', async () => {
  await expect(createAdditiveCoatMutantPublication(publication('evaluateClearcoatLayer();'), 'product', 'mutant'))
    .rejects.toThrow('attenuation needle missing');
});

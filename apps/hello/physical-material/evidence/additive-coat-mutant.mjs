import { expandShaderManifestPublication } from '@forgeax/engine-shader';

// Keep the real source publication deduplicated: an expanded Standard manifest
// can exceed V8's string limit when encoded as a data URL.
export async function createAdditiveCoatMutantPublication(publication, productIdentifier, mutantIdentifier) {
  const { sources } = expandShaderManifestPublication(publication);
  if (publication.schemaVersion !== '2.0.0') throw new Error('Expected current shader publication');
  const product = publication.materialShaders.find((row) => row.identifier === productIdentifier);
  if (product === undefined) throw new Error('Product clearcoat shader is missing');
  const fragments = [...publication.fragments];
  const sourceTable = { ...publication.sources };
  const retarget = async (row) => {
    const source = sources.get(row.sourceDigest);
    const mutated = source
      .replace('let attenuatedBase = (baseRadiance * (1f - _e2));', 'let attenuatedBase = baseRadiance;')
      .replace('let attenuatedBase = (baseRadiance_1 * (1f - _e2));', 'let attenuatedBase = baseRadiance_1;');
    if (mutated === source || !source.includes('evaluateClearcoatLayer')) {
      throw new Error('Additive mutant attenuation needle missing');
    }
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(mutated));
    const sourceDigest = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!Object.hasOwn(sourceTable, sourceDigest)) sourceTable[sourceDigest] = [fragments.push(mutated) - 1];
    return { ...row, sourceDigest };
  };
  const mutant = {
    ...await retarget(product),
    identifier: mutantIdentifier,
    variants: await Promise.all(product.variants.map(retarget)),
  };
  const materialShaders = mutantIdentifier === productIdentifier
    ? publication.materialShaders.map((row) => row === product ? mutant : row)
    : [...publication.materialShaders, mutant];
  const referenced = new Set([...publication.entries, ...materialShaders.flatMap((row) => [row, ...row.variants])].map((row) => row.sourceDigest));
  for (const digest of Object.keys(sourceTable)) if (!referenced.has(digest)) delete sourceTable[digest];
  // Expansion above admits the producer contract; every changed source gets a
  // fresh digest and unrelated rows retain their original identities.
  return { ...publication, fragments, sources: sourceTable, materialShaders };
}

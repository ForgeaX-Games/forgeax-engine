import { createHash } from 'node:crypto';

type ShaderEntry = { readonly wgsl: string };
type MaterialVariant = { readonly composedWgsl: string };
type MaterialEntry = MaterialVariant & { readonly variants: readonly MaterialVariant[] };

/** Publish each composed source once, sharing repeated source blocks across variants. */
export function publishShaderManifest<E extends ShaderEntry, M extends MaterialEntry>(
  entries: readonly E[],
  materialShaders: readonly M[],
) {
  const digests = new Map<string, string>();
  const sourceDigest = (source: string, owner: string): string => {
    if (!source || /^\.?\/[^\n]+\.composed\.wgsl$/i.test(source)) {
      throw new Error(`Shader manifest requires composed WGSL bytes: ${owner}=${source}`);
    }
    const existing = digests.get(source);
    if (existing !== undefined) return existing;
    const digest = createHash('sha256').update(source).digest('hex');
    digests.set(source, digest);
    return digest;
  };
  const programs = entries.map(({ wgsl, ...entry }, index) => ({
    ...entry,
    sourceDigest: sourceDigest(
      wgsl,
      `entry ${index} ${String('hash' in entry ? entry.hash : '')} keys ${Object.keys(entry).join(',')}`,
    ),
  }));
  const variant = ({ composedWgsl, ...entry }: MaterialVariant, owner: string) => ({
    ...entry,
    sourceDigest: sourceDigest(composedWgsl, owner),
  });
  const materials = materialShaders.map(({ variants, ...entry }, index) => ({
    ...variant(entry, `material ${index}`),
    variants: variants.map((item, variantIndex) =>
      variant(item, `material ${index} variant ${variantIndex}`),
    ),
  }));
  const fragments: string[] = [];
  const fragmentIndex = new Map<string, number>();
  const sources: Record<string, number[]> = {};
  for (const [source, digest] of [...digests].sort(([, a], [, b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    // Composed WGSL separates declarations with blank lines. Keeping those
    // blocks intact avoids thousands of repeated line indices per variant.
    // Retain every separator and final byte; fragments are transport, not parsing.
    const parts = source.split('\n\n');
    const blocks = parts
      .map((part, index) => part + (index + 1 < parts.length ? '\n\n' : ''))
      .filter(Boolean);
    sources[digest] = blocks.map((fragment) => {
      let index = fragmentIndex.get(fragment);
      if (index === undefined) {
        index = fragments.length;
        fragments.push(fragment);
        fragmentIndex.set(fragment, index);
      }
      return index;
    });
  }
  return {
    schemaVersion: '2.0.0',
    fragments,
    sources,
    entries: programs,
    materialShaders: materials,
  };
}

const digestPattern = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Pure expansion shared by browser admission and synchronous packaged-input loading. */
export function expandShaderManifestPublication(value: unknown): {
  readonly manifest: unknown;
  readonly sources: ReadonlyMap<string, string>;
} {
  if (!isRecord(value) || value.schemaVersion !== '2.0.0') {
    return { manifest: value, sources: new Map() };
  }
  if (
    !Array.isArray(value.entries) ||
    !Array.isArray(value.materialShaders) ||
    !Array.isArray(value.fragments) ||
    !value.fragments.every((fragment) => typeof fragment === 'string') ||
    !isRecord(value.sources)
  ) {
    throw new Error('Invalid shader manifest publication');
  }
  const fragments = value.fragments as string[];
  const sources = value.sources;
  const referenced = new Set<string>();
  const check = (candidate: unknown): Record<string, unknown> => {
    if (
      !isRecord(candidate) ||
      typeof candidate.sourceDigest !== 'string' ||
      !digestPattern.test(candidate.sourceDigest) ||
      ['wgsl', 'composedWgsl', 'composedWgslUrl', 'composedWgslSha256'].some((key) =>
        Object.hasOwn(candidate, key),
      )
    ) {
      throw new Error('Shader row requires one source digest');
    }
    referenced.add(candidate.sourceDigest);
    return candidate;
  };
  const entries = value.entries.map(check);
  const materials = value.materialShaders.map((candidate) => {
    const row = check(candidate);
    if (!Array.isArray(row.variants)) throw new Error('Material variants must be an array');
    return { row, variants: row.variants.map(check) as Record<string, unknown>[] };
  });
  if (Object.keys(sources).length !== referenced.size) {
    throw new Error('Shader source table has missing or unused entries');
  }
  const decoded = new Map<string, string>();
  for (const digest of referenced) {
    const indices = Object.hasOwn(sources, digest) ? sources[digest] : undefined;
    if (
      !Array.isArray(indices) ||
      indices.length === 0 ||
      !indices.every(
        (index) => Number.isSafeInteger(index) && index >= 0 && index < fragments.length,
      )
    ) {
      throw new Error(`Invalid shader source fragments: ${digest}`);
    }
    const source = indices.map((index: number) => fragments[index]).join('');
    if (!source) throw new Error(`Shader source is empty: ${digest}`);
    decoded.set(digest, source);
  }
  const expand = (row: Record<string, unknown>, field: string) => {
    const { sourceDigest, ...metadata } = row;
    const source = decoded.get(sourceDigest as string);
    if (source === undefined) throw new Error('Shader source is missing after validation');
    return { ...metadata, [field]: source };
  };
  return {
    manifest: {
      entries: entries.map((row) => expand(row, 'wgsl')),
      materialShaders: materials.map(({ row, variants }) => ({
        ...expand(row, 'composedWgsl'),
        variants: variants.map((variant) => expand(variant, 'composedWgsl')),
      })),
    },
    sources: decoded,
  };
}

/** Verify source bytes before ShaderRegistry's atomic validation. */
export async function readShaderManifestPublication(value: unknown): Promise<unknown> {
  const expanded = expandShaderManifestPublication(value);
  const sources = [...expanded.sources];
  const encoder = new TextEncoder();
  // Bound temporary UTF-8 buffers while avoiding one browser task round trip
  // per source. Publication still waits for every digest in source order.
  for (let offset = 0; offset < sources.length; offset += 16) {
    const batch = sources.slice(offset, offset + 16);
    const hashes = await Promise.all(
      batch.map(
        async ([digest, source]) =>
          [digest, await crypto.subtle.digest('SHA-256', encoder.encode(source))] as const,
      ),
    );
    for (const [digest, hash] of hashes) {
      const actual = [...new Uint8Array(hash)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      if (actual !== digest) throw new Error(`Shader source digest mismatch: ${digest}`);
    }
  }
  return expanded.manifest;
}

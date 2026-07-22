import type { ImportedAsset, ImportProduct } from '@forgeax/engine-types';

export interface TransportArtifact {
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ProjectedTransportArtifact extends TransportArtifact {
  readonly url?: string;
}

/**
 * Product-facing helpers shared by dev and build transport.
 *
 * Importers produce one generic product. Transport owns URL/hash decisions,
 * while this module keeps product traversal and GUID normalization identical
 * for every importer (image, glTF, FBX, font, and UI).
 */
export function productAssetByGuid(
  product: Pick<ImportProduct, 'assets'>,
  guid: string,
): ImportedAsset | undefined {
  const wanted = guid.toLowerCase();
  return product.assets.find((asset) => asset.guid.toLowerCase() === wanted);
}

export function productAssetsByGuid(
  product: Pick<ImportProduct, 'assets'>,
): ReadonlyMap<string, ImportedAsset> {
  const assets = new Map<string, ImportedAsset>();
  for (const asset of product.assets) {
    assets.set(asset.guid.toLowerCase(), asset);
  }
  return assets;
}

export function productArtifactsByPath(
  product: Pick<ImportProduct, 'artifacts'>,
): ReadonlyMap<string, (typeof product.artifacts)[number]> {
  const artifacts = new Map<string, (typeof product.artifacts)[number]>();
  for (const artifact of product.artifacts) {
    artifacts.set(artifact.path, artifact);
  }
  return artifacts;
}

export function projectUiDevArtifacts(
  artifacts: readonly TransportArtifact[],
  prefix = '/__ui/',
): readonly (TransportArtifact & { readonly url: string })[] {
  const root = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return artifacts.map((artifact) => ({
    ...artifact,
    url: `${root}${artifact.path.replace(/^\/+/, '')}`,
  }));
}

export function projectUiBuildArtifacts(
  artifacts: readonly TransportArtifact[],
  hashedPath: (artifact: TransportArtifact) => string,
): readonly TransportArtifact[] {
  return artifacts.map((artifact) => ({ ...artifact, path: hashedPath(artifact) }));
}

export function createUiRefreshState(): {
  replace(guid: string, instance: string): { previous: string | undefined; current: string };
  snapshot(): readonly (readonly [string, string])[];
} {
  const instances = new Map<string, string>();
  return {
    replace(guid, instance) {
      const previous = instances.get(guid);
      instances.set(guid, instance);
      return { previous, current: instance };
    },
    snapshot() {
      return [...instances.entries()];
    },
  };
}

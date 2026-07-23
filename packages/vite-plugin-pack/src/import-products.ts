import type { ImportedAsset, ImportProduct } from '@forgeax/engine-types';

export const UI_DEPENDENCY_CONSUMER_CHANNELS = [
  'typescript-import',
  'script-literal',
  'json-pack-manifest',
] as const;

export type UiDependencyConsumerChannel = (typeof UI_DEPENDENCY_CONSUMER_CHANNELS)[number];

export type UiDependencyKind = 'html' | 'css' | 'companion';

export interface UiDependencyConsumer {
  readonly channel: UiDependencyConsumerChannel;
  readonly path: string;
  readonly kind: UiDependencyKind;
}

export interface UiDependencyConsumerInputs {
  readonly typescriptImports?: readonly string[];
  readonly scriptLiterals?: readonly string[];
  readonly manifestEntries?: readonly string[];
}

function dependencyKind(path: string): UiDependencyKind | undefined {
  const lower = path.toLowerCase().split(/[?#]/, 1)[0] ?? '';
  if (lower.endsWith('.ui.html') || lower.endsWith('.html')) return 'html';
  if (lower.endsWith('.ui.css') || lower.endsWith('.css')) return 'css';
  if (
    lower.endsWith('.png') ||
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.woff') ||
    lower.endsWith('.woff2')
  ) {
    return 'companion';
  }
  return undefined;
}

/**
 * Enumerate every source consumer channel that can carry a UI dependency.
 * The importer/product channel is represented by the manifest list because
 * it is the serialized pack form consumed by the runtime.
 */
export function enumerateUiDependencyConsumers(
  inputs: UiDependencyConsumerInputs,
): readonly UiDependencyConsumer[] {
  const groups: readonly [UiDependencyConsumerChannel, readonly string[] | undefined][] = [
    ['typescript-import', inputs.typescriptImports],
    ['script-literal', inputs.scriptLiterals],
    ['json-pack-manifest', inputs.manifestEntries],
  ];
  const seen = new Set<string>();
  const consumers: UiDependencyConsumer[] = [];
  for (const [channel, paths] of groups) {
    for (const path of paths ?? []) {
      const kind = dependencyKind(path);
      if (kind === undefined) continue;
      const key = `${channel}\0${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      consumers.push({ channel, path, kind });
    }
  }
  return consumers;
}

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

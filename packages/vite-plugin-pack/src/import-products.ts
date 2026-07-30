import { normaliseForPack } from '@forgeax/engine-import';
import type { ImportedArtifactBody, ImportedAsset, ImportProduct } from '@forgeax/engine-types';
import type { LogicalPackage } from './package-finalizer.js';

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
  product: Pick<ImportProduct, 'assets'>,
  guid?: string,
): ReadonlyMap<string, ImportedArtifactBody> {
  const asset = guid === undefined ? product.assets[0] : productAssetByGuid(product, guid);
  return new Map(Object.entries(asset?.artifacts ?? {}));
}

export function productBinaryArtifacts(
  product: Pick<ImportProduct, 'assets'>,
): ReadonlyMap<string, Uint8Array> {
  const binaries = new Map<string, Uint8Array>();
  for (const asset of product.assets) {
    if (asset.kind !== 'mesh' && asset.kind !== 'texture') continue;
    const first = Object.entries(asset.artifacts).sort(([left], [right]) =>
      left.localeCompare(right),
    )[0]?.[1];
    if (first !== undefined) binaries.set(asset.guid.toLowerCase(), first.bytes);
  }
  return binaries;
}

export function logicalPackageFromImportProduct(
  product: Pick<ImportProduct<unknown>, 'assets'>,
): LogicalPackage {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: product.assets.map((asset) => ({
      guid: asset.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      // Mesh geometry is runtime-only binary data once its asset-local body
      // artifact exists. Keeping the typed-array payload beside that body
      // duplicates the cook and can exceed JSON transport limits for large
      // glTF scenes; inline authored mesh packs retain their payload because
      // they have no cooked body artifact to replace it.
      payload: normaliseForPack(cookedPayload(asset)) as Record<string, unknown>,
      refs: asset.refs.map((ref) => ref.guid),
      artifacts: asset.artifacts,
    })),
  };
}

function cookedPayload(asset: ImportedAsset<unknown>): Record<string, unknown> {
  const payload = asset.payload as unknown as Record<string, unknown>;
  if (Object.keys(asset.artifacts).length === 0) return payload;
  if (asset.kind === 'mesh') return { kind: 'mesh' };
  if (asset.kind === 'texture' || asset.kind === 'equirect') {
    const { data: _runtimeBytes, ...metadata } = payload;
    return metadata;
  }
  return payload;
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

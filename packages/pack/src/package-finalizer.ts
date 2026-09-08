import { createHash } from 'node:crypto';
import type { AssetCodec, AssetRelation, CookReceipt } from '@forgeax/engine-types';

export interface PackageArtifactBody {
  readonly mediaType: string;
  readonly assetCodec?: AssetCodec;
  readonly bytes: Uint8Array;
}

export interface PackageProductAsset {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, PackageArtifactBody>>;
}

export interface PackageProduct {
  readonly assets: readonly PackageProductAsset[];
  readonly receipts: readonly CookReceipt[];
  readonly diagnostics: readonly unknown[];
  readonly sourceRevision: string;
  readonly sourceKey?: string;
}

/** Minimal authored Pack v1/v2 shape consumed by the file transport seam. */
export interface AuthoredPackAssetInput {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly execution?: 'direct' | 'cooked';
  readonly sourceKey?: string;
  readonly sourceIndex?: number;
  readonly relations?: readonly AssetRelation[];
  readonly payload: Record<string, unknown>;
  readonly refs?: readonly string[];
  readonly artifacts?: Readonly<Record<string, unknown>>;
}

export interface AuthoredPackInput {
  readonly schemaVersion?: string;
  readonly assets?: readonly AuthoredPackAssetInput[];
}

export interface PackageDocumentArtifact {
  readonly path: string;
  readonly mediaType: string;
  readonly assetCodec?: AssetCodec;
  readonly byteLength: number;
  readonly integrity: { readonly algorithm: 'sha256'; readonly digest: string };
}

export interface PackageDocumentAsset {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly payload: Record<string, unknown>;
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, PackageDocumentArtifact>>;
}

export interface PackageDocument {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'internal-text-package';
  readonly assets: readonly PackageDocumentAsset[];
}

function legacyMaterialPayload(payload: Record<string, unknown>): Record<string, unknown> {
  if (payload.kind !== 'material') return payload;

  const { paramValues, passes, ...currentPayload } = payload;
  return {
    ...currentPayload,
    ...(currentPayload.values === undefined && paramValues !== undefined
      ? { values: paramValues }
      : {}),
    ...(Array.isArray(passes)
      ? {
          passes: passes.map((candidate) => {
            if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate))
              return candidate;
            const pass = candidate as Record<string, unknown>;
            const { shader, tags, queue, ...currentPass } = pass;
            const legacyRenderState = {
              ...(typeof currentPass.renderState === 'object' &&
              currentPass.renderState !== null &&
              !Array.isArray(currentPass.renderState)
                ? (currentPass.renderState as Record<string, unknown>)
                : {}),
              ...(tags === undefined ? {} : { tags }),
              ...(queue === undefined ? {} : { queue }),
            };
            return {
              ...currentPass,
              ...(currentPass.program === undefined && typeof shader === 'string'
                ? { program: { module: shader } }
                : {}),
              ...(Object.keys(legacyRenderState).length === 0
                ? {}
                : { renderState: legacyRenderState }),
            };
          }),
        }
      : {}),
  };
}

/** Upgrade the legacy authored Pack envelope at the Pack schema boundary. */
export function upgradeLegacyAuthoredPack(pack: AuthoredPackInput): AuthoredPackInput {
  if (pack.schemaVersion !== '1.0.0' || pack.assets === undefined) return pack;
  return {
    ...pack,
    schemaVersion: '2.0.0',
    assets: pack.assets.map((asset) => {
      const fontRefs =
        asset.kind === 'font'
          ? [asset.payload.atlasGuid, asset.payload.samplerGuid].filter(
              (guid): guid is string => typeof guid === 'string',
            )
          : [];
      return {
        ...asset,
        payload: legacyMaterialPayload(asset.payload),
        refs: asset.refs ?? fontRefs,
        artifacts: asset.artifacts ?? {},
      };
    }),
  };
}

export interface PackageFinalizePolicy {
  readonly base: string;
  readonly packagePath: string;
  readonly artifactPath: (guid: string, localKey: string) => string;
  readonly sink?: (path: string, bytes: Uint8Array) => void | Promise<void>;
}

export interface FinalizedPackageProduct {
  readonly pack: PackageDocument;
  readonly packageUrl: string;
  readonly digest: string;
  readonly receipts: readonly CookReceipt[];
  readonly diagnostics: readonly unknown[];
  readonly sourceRevision: string;
  readonly sourceKey?: string;
}

interface PackageTransportSource {
  readonly assets: readonly PackageProduct['assets'][number][];
  readonly receipts?: readonly CookReceipt[];
  readonly diagnostics?: readonly unknown[];
  readonly sourceKey?: string;
}

export interface PackageFinalizerError {
  readonly code:
    | 'duplicate-guid'
    | 'missing-source-revision'
    | 'missing-receipt'
    | 'invalid-artifact';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly guid?: string; readonly key?: string };
}

export type PackageFinalizeResult =
  | { readonly ok: true; readonly value: FinalizedPackageProduct }
  | { readonly ok: false; readonly error: PackageFinalizerError };

function failure(
  code: PackageFinalizerError['code'],
  expected: string,
  hint: string,
  detail: PackageFinalizerError['detail'],
): PackageFinalizeResult {
  return { ok: false, error: { code, expected, hint, detail } };
}

function sorted(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = sorted((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

function packageUrl(base: string, packagePath: string): string {
  const prefix = base === '/' ? '' : `/${base.replace(/^\/+|\/+$/g, '')}`;
  return `${prefix}/${packagePath.replace(/^\/+/, '')}`;
}

function safePath(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  return (
    normalized.length > 0 &&
    !normalized.startsWith('/') &&
    !/^[A-Za-z]:\//.test(normalized) &&
    !normalized.split('/').includes('..')
  );
}

function digest(assets: readonly PackageProductAsset[]): string {
  const pack = { schemaVersion: '2.0.0', kind: 'internal-text-package', assets } as const;
  const hash = createHash('sha256').update(
    JSON.stringify(
      sorted({
        ...pack,
        assets: pack.assets.map((asset) => ({
          ...asset,
          artifacts: Object.fromEntries(
            Object.entries(asset.artifacts).map(([key, artifact]) => [
              key,
              {
                mediaType: artifact.mediaType,
                ...(artifact.assetCodec === undefined ? {} : { assetCodec: artifact.assetCodec }),
                byteLength: artifact.bytes.byteLength,
              },
            ]),
          ),
        })),
      }),
    ),
  );
  for (const [key, artifact] of assets
    .flatMap((asset) =>
      Object.entries(asset.artifacts).map(
        ([localKey, body]) => [`${asset.guid}/${localKey}`, body] as const,
      ),
    )
    .sort(([left], [right]) => left.localeCompare(right))) {
    hash.update(key).update(artifact.bytes);
  }
  return `sha256:${hash.digest('hex')}`;
}

function packageDocument(
  assets: readonly PackageProductAsset[],
  artifactPath: (guid: string, localKey: string) => string,
): PackageDocument {
  return {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets: assets.map((asset) => ({
      guid: asset.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      payload: asset.payload,
      refs: asset.refs,
      artifacts: Object.fromEntries(
        Object.entries(asset.artifacts).map(([key, artifact]) => [
          key,
          {
            path: artifactPath(asset.guid, key),
            mediaType: artifact.mediaType,
            ...(artifact.assetCodec === undefined ? {} : { assetCodec: artifact.assetCodec }),
            contentEncoding: 'identity' as const,
            byteLength: artifact.bytes.byteLength,
            integrity: {
              algorithm: 'sha256' as const,
              digest: `sha256:${createHash('sha256').update(artifact.bytes).digest('hex')}`,
            },
          },
        ]),
      ),
    })),
  };
}

function transportArtifacts(
  assets: readonly PackageProductAsset[],
  artifactPath: PackageFinalizePolicy['artifactPath'],
) {
  return assets.flatMap((asset) =>
    Object.entries(asset.artifacts).flatMap(([localKey, artifact]) => [
      {
        guid: asset.guid,
        localKey,
        path: artifactPath(asset.guid, localKey),
        mediaType: artifact.mediaType,
        ...(artifact.assetCodec === undefined ? {} : { assetCodec: artifact.assetCodec }),
        bytes: artifact.bytes,
      },
    ]),
  );
}

/** Finalize a complete producer product without owning producer-specific policy. */
export async function finalizePackageProduct(
  product: PackageProduct,
  policy: PackageFinalizePolicy,
): Promise<PackageFinalizeResult> {
  if (product.sourceRevision.trim().length === 0) {
    return failure(
      'missing-source-revision',
      'a non-empty source revision',
      'rebuild the inventory and provide the producer source revision',
      {},
    );
  }
  const seen = new Set<string>();
  for (const asset of product.assets) {
    const guid = asset.guid.toLowerCase();
    if (seen.has(guid)) {
      return failure(
        'duplicate-guid',
        'one terminal product row per GUID',
        'repair the inventory or producer output before finalization',
        { guid },
      );
    }
    seen.add(guid);
    for (const [key, artifact] of Object.entries(asset.artifacts)) {
      if (!safePath(key) || !(artifact.bytes instanceof Uint8Array)) {
        return failure(
          'invalid-artifact',
          'asset-local artifact keys and byte bodies',
          'repair the producer artifact before finalization',
          { guid, key },
        );
      }
    }
  }
  for (const guid of seen) {
    if (!product.receipts.some((receipt) => receipt.guid.toLowerCase() === guid)) {
      return failure(
        'missing-receipt',
        'one receipt for every terminal product GUID',
        'preserve the producer receipt when handing the product to engine-pack',
        { guid },
      );
    }
  }
  const assets = [...product.assets].sort((left, right) => left.guid.localeCompare(right.guid));
  const document = packageDocument(assets, policy.artifactPath);
  const packageBytes = new TextEncoder().encode(JSON.stringify(sorted(document)));
  if (policy.sink !== undefined) {
    for (const asset of assets) {
      for (const [key, artifact] of Object.entries(asset.artifacts)) {
        const path = policy.artifactPath(asset.guid, key);
        if (!safePath(path)) {
          return failure(
            'invalid-artifact',
            'package-relative artifact output paths',
            'repair the finalizer artifact path policy',
            { guid: asset.guid, key },
          );
        }
        await policy.sink(path, artifact.bytes);
      }
    }
    if (!safePath(policy.packagePath)) {
      return failure(
        'invalid-artifact',
        'a package-relative package path',
        'repair the finalizer package path policy',
        { key: policy.packagePath },
      );
    }
    await policy.sink(policy.packagePath, packageBytes);
  }
  return {
    ok: true,
    value: {
      pack: document,
      packageUrl: packageUrl(policy.base, policy.packagePath),
      digest: digest(product.assets),
      receipts: product.receipts,
      diagnostics: product.diagnostics,
      sourceRevision: product.sourceRevision,
      ...(product.sourceKey === undefined ? {} : { sourceKey: product.sourceKey }),
    },
  };
}

/** Finalize a product-shaped source with the deterministic transport revision. */
export async function finalizePackageTransportSource(
  input: PackageTransportSource,
  policy: PackageFinalizePolicy,
) {
  const sourceRevision = packageTransportRevision(input);
  const product: PackageProduct = {
    assets: input.assets,
    receipts:
      input.receipts ??
      input.assets.map((asset) => ({
        guid: asset.guid,
        origin: 'sourceMeta' as const,
        status: 'succeeded' as const,
        inputFingerprint: sourceRevision,
      })),
    diagnostics: input.diagnostics ?? [],
    sourceRevision,
    ...(input.sourceKey === undefined ? {} : { sourceKey: input.sourceKey }),
  };
  const finalized = await finalizePackageProduct(product, policy);
  if (!finalized.ok) throw finalized.error;
  return {
    pack: finalized.value.pack,
    packageUrl: finalized.value.packageUrl,
    artifacts: transportArtifacts(product.assets, policy.artifactPath),
    digest: finalized.value.digest,
    sourceRevision,
    semantic: JSON.stringify(sorted(finalized.value.pack)),
  };
}

function revisionStable(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return {
      byteLength: value.byteLength,
      digest: createHash('sha256').update(value).digest('hex'),
    };
  }
  if (Array.isArray(value)) return value.map(revisionStable);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, revisionStable(item)]),
    );
  }
  return value;
}

export function packageTransportRevision(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(revisionStable(value)))
    .digest('hex');
}

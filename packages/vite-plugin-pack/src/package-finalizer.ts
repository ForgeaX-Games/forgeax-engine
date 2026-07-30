import { createHash } from 'node:crypto';
import type {
  ArtifactDescriptor,
  AssetCodec,
  ContentEncoding,
  PackV2,
} from '@forgeax/engine-types';

export interface LogicalArtifactBody {
  readonly mediaType: string;
  readonly assetCodec?: AssetCodec;
  readonly bytes: Uint8Array;
}

export interface LogicalPackageAsset {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly payload: Record<string, unknown>;
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, LogicalArtifactBody>>;
}

export interface LogicalPackage {
  readonly schemaVersion: '2.0.0';
  readonly kind: 'internal-text-package';
  readonly assets: readonly LogicalPackageAsset[];
}

export interface PackageSink {
  write(path: string, bytes: Uint8Array): void | Promise<void>;
}

export interface FinalizePolicy {
  readonly base: string;
  readonly packagePath: string;
  readonly artifactPath: (guid: string, localKey: string) => string;
  readonly contentEncoding?: ContentEncoding;
}

export interface FinalizedArtifact {
  readonly guid: string;
  readonly localKey: string;
  readonly path: string;
  readonly mediaType: string;
  readonly assetCodec?: AssetCodec;
  readonly contentEncoding: ContentEncoding;
  readonly bytes: Uint8Array;
}

export interface FinalizedPackage {
  readonly pack: PackV2;
  readonly packageUrl: string;
  readonly artifacts: readonly FinalizedArtifact[];
  readonly semantic: string;
}

function sortValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      output[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return output;
  }
  return value;
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('base64');
}

function relativePath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  if (
    path.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(path) ||
    normalized.length === 0 ||
    normalized.split('/').some((part) => part === '..')
  ) {
    throw new Error(`finalizer path must stay package-relative: ${path}`);
  }
  return normalized;
}

function packageUrl(base: string, path: string): string {
  const prefix = base === '/' ? '' : `/${base.replace(/^\/+|\/+$/g, '')}`;
  return `${prefix}/${path.replace(/^\/+/, '')}`;
}

function semanticAsset(
  asset: LogicalPackageAsset,
  contentEncoding: ContentEncoding,
): Record<string, unknown> {
  const artifacts: Record<string, unknown> = {};
  for (const key of Object.keys(asset.artifacts).sort()) {
    const artifact = asset.artifacts[key];
    if (artifact === undefined) continue;
    artifacts[key] = {
      mediaType: artifact.mediaType,
      ...(artifact.assetCodec === undefined ? {} : { assetCodec: sortValue(artifact.assetCodec) }),
      contentEncoding,
      bytes: base64(artifact.bytes),
    };
  }
  return {
    guid: asset.guid,
    kind: asset.kind,
    ...(asset.name === undefined ? {} : { name: asset.name }),
    payload: sortValue(asset.payload),
    refs: [...asset.refs].sort(),
    artifacts,
  };
}

/** Return the stable comparison view; publish paths and integrity are derived facts. */
export function canonicalizeLogicalPackage(
  logicalPackage: LogicalPackage,
  contentEncoding: ContentEncoding = 'identity',
): string {
  return JSON.stringify({
    schemaVersion: logicalPackage.schemaVersion,
    kind: logicalPackage.kind,
    assets: [...logicalPackage.assets]
      .sort((left, right) => left.guid.localeCompare(right.guid))
      .map((asset) => semanticAsset(asset, contentEncoding)),
  });
}

/** Finalize one logical package for any sink without changing producer-owned facts. */
export async function finalizePackage(
  logicalPackage: LogicalPackage,
  sink: PackageSink,
  policy: FinalizePolicy,
): Promise<FinalizedPackage> {
  const contentEncoding = policy.contentEncoding ?? 'identity';
  const artifacts: FinalizedArtifact[] = [];
  // The semantic projection is a diagnostic/comparison view. Build publication
  // only needs the pack and artifact descriptors; eagerly base64-encoding every
  // artifact here can briefly duplicate hundreds of megabytes of payload data.
  let semantic: string | undefined;
  const assets = [...logicalPackage.assets]
    .sort((left, right) => left.guid.localeCompare(right.guid))
    .map((asset) => {
      const descriptors: Record<string, ArtifactDescriptor> = {};
      for (const localKey of Object.keys(asset.artifacts).sort()) {
        const body = asset.artifacts[localKey];
        if (body === undefined) continue;
        const path = relativePath(policy.artifactPath(asset.guid, localKey));
        descriptors[localKey] = {
          path,
          mediaType: body.mediaType,
          ...(body.assetCodec === undefined ? {} : { assetCodec: body.assetCodec }),
          contentEncoding,
          byteLength: body.bytes.byteLength,
          integrity: { algorithm: 'sha256', digest: digest(body.bytes) },
        };
        artifacts.push({
          guid: asset.guid,
          localKey,
          path,
          mediaType: body.mediaType,
          ...(body.assetCodec === undefined ? {} : { assetCodec: body.assetCodec }),
          contentEncoding,
          bytes: body.bytes,
        });
      }
      return {
        guid: asset.guid,
        kind: asset.kind,
        ...(asset.name === undefined ? {} : { name: asset.name }),
        payload: asset.payload,
        refs: asset.refs,
        artifacts: descriptors,
      };
    });
  const pack: PackV2 = {
    schemaVersion: '2.0.0',
    kind: 'internal-text-package',
    assets,
  };
  for (const artifact of artifacts) await sink.write(artifact.path, artifact.bytes);
  const packPath = relativePath(policy.packagePath);
  await sink.write(packPath, new TextEncoder().encode(JSON.stringify(sortValue(pack))));
  return {
    pack,
    packageUrl: packageUrl(policy.base, packPath),
    artifacts,
    get semantic() {
      semantic ??= canonicalizeLogicalPackage(logicalPackage, contentEncoding);
      return semantic;
    },
  };
}

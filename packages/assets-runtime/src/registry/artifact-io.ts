import { decompressZstd } from '@forgeax/engine-codec';
import { validateArtifactPath } from '@forgeax/engine-pack';
import type { ArtifactDescriptor, AssetArtifactError } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';
import { bytesOf, type PackageFetcher, readPackage } from '../internal/package-read.js';
import { traceAssetLoadPhase } from './load-trace';

export interface ArtifactReadRequest {
  readonly packageUrl: string;
  readonly guid: string;
  readonly artifactKey: string;
  readonly descriptor: ArtifactDescriptor;
}

export type ArtifactFetcher = PackageFetcher;

function failure(
  code: AssetArtifactError['code'],
  request: ArtifactReadRequest,
  expected: string,
  hint: string,
  observed: string,
): AssetArtifactError {
  if (code === 'asset-artifact-missing') {
    return {
      code,
      expected,
      hint,
      detail: {
        guid: request.guid,
        artifactKey: request.artifactKey,
        path: request.descriptor.path,
        observed,
        expected,
      },
    };
  }
  return {
    code,
    expected,
    hint,
    detail: {
      guid: request.guid,
      artifactKey: request.artifactKey,
      observed,
      expected,
    },
  };
}

export function artifactUrl(packageUrl: string, path: string): string {
  try {
    return new URL(path, new URL(packageUrl, globalThis.location?.href)).toString();
  } catch {
    const queryIndex = packageUrl.search(/[?#]/);
    const cleanPackageUrl = queryIndex < 0 ? packageUrl : packageUrl.slice(0, queryIndex);
    const slash = cleanPackageUrl.lastIndexOf('/');
    return `${slash < 0 ? '' : cleanPackageUrl.slice(0, slash + 1)}${path}`;
  }
}

function encodedBytes(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

function hexBytes(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: Uint8Array): Promise<{ base64: string; hex: string } | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return undefined;
  const digest = await subtle.digest('SHA-256', bytes.slice().buffer as ArrayBuffer);
  const digestBytes = new Uint8Array(digest);
  return { base64: encodedBytes(digestBytes), hex: hexBytes(digestBytes) };
}

async function decodeOuter(
  bytes: Uint8Array,
  request: ArtifactReadRequest,
): Promise<Result<Uint8Array, AssetArtifactError>> {
  const encoding = request.descriptor.contentEncoding ?? 'identity';
  if (encoding === 'identity') return ok(bytes);
  if (encoding !== 'zstd') {
    return err(
      failure(
        'asset-artifact-encoding-unsupported',
        request,
        "contentEncoding 'identity' or 'zstd'",
        'change the descriptor to a supported outer content encoding and re-cook the package',
        encoding,
      ),
    );
  }
  const decoded = await decompressZstd(bytes);
  if (!decoded.ok) {
    return err(
      failure(
        'asset-artifact-decode-failed',
        request,
        'valid bytes for the declared outer content encoding',
        're-cook the artifact and verify the stored bytes before loading again',
        JSON.stringify(decoded.error.detail),
      ),
    );
  }
  return ok(decoded.value);
}

async function verifyBytes(
  bytes: Uint8Array,
  request: ArtifactReadRequest,
): Promise<Result<Uint8Array, AssetArtifactError>> {
  const expectedLength = request.descriptor.byteLength;
  if (expectedLength !== undefined && expectedLength !== bytes.byteLength) {
    return err(
      failure(
        'asset-artifact-integrity-mismatch',
        request,
        `decoded artifact byteLength ${expectedLength}`,
        're-cook the package or update its artifact descriptor to match the bytes',
        String(bytes.byteLength),
      ),
    );
  }
  const integrity = request.descriptor.integrity;
  if (integrity === undefined) return ok(bytes);
  const digest = await sha256(bytes);
  if (digest === undefined) {
    return err(
      failure(
        'asset-artifact-integrity-mismatch',
        request,
        'a runtime with Web Crypto SHA-256 support',
        'enable Web Crypto or remove the unverifiable artifact from the package',
        'crypto.subtle unavailable',
      ),
    );
  }
  const expectedDigest = integrity.digest.startsWith('sha256:')
    ? integrity.digest.slice('sha256:'.length)
    : integrity.digest;
  if (expectedDigest !== digest.base64 && expectedDigest.toLowerCase() !== digest.hex) {
    return err(
      failure(
        'asset-artifact-integrity-mismatch',
        request,
        `sha256 digest ${integrity.digest}`,
        're-cook the artifact or replace the corrupted stored bytes',
        digest.base64,
      ),
    );
  }
  return ok(bytes);
}

export async function readArtifact(
  request: ArtifactReadRequest,
  fetcher: ArtifactFetcher = (url, init) => globalThis.fetch(url, init),
): Promise<Result<Uint8Array, AssetArtifactError>> {
  if (request.descriptor.mediaType.trim().length === 0) {
    return err(
      failure(
        'asset-artifact-media-unsupported',
        request,
        'a non-empty durable artifact mediaType',
        'set the artifact mediaType during production and re-publish the package',
        request.descriptor.mediaType,
      ),
    );
  }
  const path = validateArtifactPath(request.descriptor.path, {
    packageRoot: request.packageUrl,
    guid: request.guid,
    artifactKey: request.artifactKey,
  });
  if (!path.ok) return path;

  const encoding = request.descriptor.contentEncoding ?? 'identity';
  if (encoding !== 'identity' && encoding !== 'zstd') {
    return err(
      failure(
        'asset-artifact-encoding-unsupported',
        request,
        "contentEncoding 'identity' or 'zstd'",
        'change the descriptor to a supported outer content encoding and re-cook the package',
        encoding,
      ),
    );
  }

  const url = artifactUrl(request.packageUrl, path.value);
  traceAssetLoadPhase('artifact.fetch.start', {
    guid: request.guid,
    packageUrl: request.packageUrl,
    artifactKey: request.artifactKey,
    detail: { url },
  });
  const read = await readPackage(fetcher, url, bytesOf);
  if (!read.ok) {
    return err(
      failure(
        'asset-artifact-missing',
        request,
        `readable artifact at ${path.value}`,
        `publish the artifact at the declared package-relative path and retry the load (${read.error.attempts} request(s))`,
        read.error.observed,
      ),
    );
  }
  const bytes = read.value;
  traceAssetLoadPhase('artifact.body.complete', {
    guid: request.guid,
    packageUrl: request.packageUrl,
    artifactKey: request.artifactKey,
    detail: { byteLength: bytes.byteLength },
  });
  const decoded = await decodeOuter(bytes, request);
  if (!decoded.ok) return decoded;
  traceAssetLoadPhase('artifact.decode.complete', {
    guid: request.guid,
    packageUrl: request.packageUrl,
    artifactKey: request.artifactKey,
    detail: { byteLength: decoded.value.byteLength },
  });
  const verified = await verifyBytes(decoded.value, request);
  traceAssetLoadPhase('artifact.verify.complete', {
    guid: request.guid,
    packageUrl: request.packageUrl,
    artifactKey: request.artifactKey,
    detail: { ok: verified.ok },
  });
  return verified;
}

export class ArtifactReadCache {
  private readonly cache = new Map<string, Promise<Result<Uint8Array, AssetArtifactError>>>();

  read(
    key: string,
    reader: () => Promise<Result<Uint8Array, AssetArtifactError>>,
  ): Promise<Result<Uint8Array, AssetArtifactError>> {
    const existing = this.cache.get(key);
    if (existing !== undefined) return existing;
    const pending = reader();
    this.cache.set(key, pending);
    void pending.then((result) => {
      // An invalidated old read must not erase a newer read of the same key.
      if (!result.ok && this.cache.get(key) === pending) this.cache.delete(key);
    });
    return pending;
  }

  clear(key?: string): void {
    if (key === undefined) this.cache.clear();
    else this.cache.delete(key);
  }

  clearPrefix(prefix: string): void {
    for (const key of this.cache.keys()) if (key.startsWith(prefix)) this.cache.delete(key);
  }
}

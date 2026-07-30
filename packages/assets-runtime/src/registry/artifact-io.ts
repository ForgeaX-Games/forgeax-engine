import { decompressZstd } from '@forgeax/engine-codec';
import { validateArtifactPath } from '@forgeax/engine-pack';
import type { ArtifactDescriptor, AssetArtifactError } from '@forgeax/engine-types';
import { err, ok, type Result } from '@forgeax/engine-types';

export interface ArtifactReadRequest {
  readonly packageUrl: string;
  readonly guid: string;
  readonly artifactKey: string;
  readonly descriptor: ArtifactDescriptor;
}

export type ArtifactFetcher = (url: string) => Promise<Response>;

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

function artifactUrl(packageUrl: string, path: string): string {
  try {
    return new URL(path, packageUrl).toString();
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
  if (integrity.digest !== digest.base64 && integrity.digest.toLowerCase() !== digest.hex) {
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
  fetcher: ArtifactFetcher = (url) => globalThis.fetch(url),
): Promise<Result<Uint8Array, AssetArtifactError>> {
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
  let response: Response;
  try {
    response = await fetcher(url);
  } catch (cause) {
    return err(
      failure(
        'asset-artifact-missing',
        request,
        `readable artifact at ${path.value}`,
        'publish the artifact at the declared package-relative path and retry the load',
        cause instanceof Error ? cause.message : 'artifact fetch failed',
      ),
    );
  }
  if (!response.ok) {
    return err(
      failure(
        'asset-artifact-missing',
        request,
        `HTTP 200 for artifact at ${path.value}`,
        'publish the missing artifact and retry the load',
        `HTTP ${response.status}`,
      ),
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (cause) {
    return err(
      failure(
        'asset-artifact-missing',
        request,
        `readable artifact at ${path.value}`,
        'repair the published artifact and retry the load',
        cause instanceof Error ? cause.message : 'artifact body unreadable',
      ),
    );
  }
  const decoded = await decodeOuter(bytes, request);
  if (!decoded.ok) return decoded;
  return verifyBytes(decoded.value, request);
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
      if (!result.ok) this.cache.delete(key);
    });
    return pending;
  }

  clear(key?: string): void {
    if (key === undefined) this.cache.clear();
    else this.cache.delete(key);
  }
}

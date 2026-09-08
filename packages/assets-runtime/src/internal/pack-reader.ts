import type {
  AssetEnvelopeV2,
  AssetLoadError,
  AssetPublicationTuple,
  PackV2,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';

export interface PackReaderOptions {
  readonly fetcher?: typeof globalThis.fetch;
}

export type VerifiedPack = PackV2<unknown>;

function invalid(guid: string, reason: string): Result<never, AssetLoadError> {
  return err({
    code: 'asset-package-invalid',
    expected: 'a verified Pack v2 envelope with complete runtime artifacts',
    hint: 're-cook the Pack v2 publication and retry the current tuple',
    detail: { guid, reason },
  });
}

function frozen<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) frozen(child);
  }
  return value;
}

function sameTuple(left: AssetPublicationTuple, right: AssetPublicationTuple): boolean {
  return (
    left.scopeId === right.scopeId &&
    left.generation === right.generation &&
    left.digest === right.digest &&
    left.outputSetDigest === right.outputSetDigest
  );
}

export class PackReader {
  private readonly fetcher: typeof globalThis.fetch | undefined;
  private readonly verified = new Map<string, VerifiedPack>();
  private readonly pending = new Map<string, Promise<Result<VerifiedPack, AssetLoadError>>>();

  constructor(options: PackReaderOptions = {}) {
    // An injected fetcher is an explicit transport lease and is fixed for the
    // reader lifetime. With no injection, resolve the host fetch at read time:
    // App assembly can precede a dev/test host installing its transport.
    this.fetcher = options.fetcher?.bind(globalThis);
  }

  async read(
    packageUrl: string,
    expected: AssetPublicationTuple,
    signal: AbortSignal,
  ): Promise<Result<VerifiedPack, AssetLoadError>> {
    if (signal.aborted) return err(this.cancelled(packageUrl));
    const key = this.key(packageUrl, expected);
    const cached = this.verified.get(key);
    if (cached !== undefined) return ok(cached);
    const active = this.pending.get(key);
    if (active !== undefined) return active;
    const request = this.fetchAndVerify(packageUrl, expected, signal);
    this.pending.set(key, request);
    const result = await request;
    this.pending.delete(key);
    if (result.ok) this.verified.set(key, result.value);
    return result;
  }

  private async fetchAndVerify(
    packageUrl: string,
    expected: AssetPublicationTuple,
    signal: AbortSignal,
  ): Promise<Result<VerifiedPack, AssetLoadError>> {
    let response: Response;
    try {
      const fetcher = this.fetcher ?? globalThis.fetch.bind(globalThis);
      response = await fetcher(packageUrl, { signal });
    } catch (_cause) {
      if (signal.aborted) return err(this.cancelled(packageUrl));
      return err({
        code: 'asset-fetch-failed',
        expected: 'HTTP 200 for the current Pack URL',
        hint: 'verify the package locator and republish the Pack',
        detail: { guid: packageUrl, packageUrl },
      });
    }
    if (!response.ok) {
      return err({
        code: 'asset-fetch-failed',
        expected: 'HTTP 200 for the current Pack URL',
        hint: 'verify the package locator and republish the Pack',
        detail: { guid: packageUrl, packageUrl },
      });
    }
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      return invalid(packageUrl, 'invalid JSON');
    }
    return this.verify(value, expected);
  }

  private key(packageUrl: string, tuple: AssetPublicationTuple): string {
    return `${packageUrl}\u0000${tuple.scopeId}\u0000${tuple.generation}\u0000${tuple.digest}\u0000${tuple.outputSetDigest}`;
  }

  verify(value: unknown, expected: AssetPublicationTuple): Result<VerifiedPack, AssetLoadError> {
    if (value === null || typeof value !== 'object') return invalid('', 'Pack is not an object');
    const pack = value as Partial<PackV2<unknown>>;
    if (pack.schemaVersion !== '2.0.0' || pack.kind !== 'internal-text-package') {
      return invalid('', 'schemaVersion or kind');
    }
    if (
      typeof pack.scopeId !== 'string' ||
      !Number.isSafeInteger(pack.generation) ||
      typeof pack.digest !== 'string' ||
      typeof pack.outputSetDigest !== 'string' ||
      !sameTuple(pack as AssetPublicationTuple, expected)
    ) {
      return invalid('', 'publication tuple mismatch');
    }
    if (!Array.isArray(pack.assets)) return invalid('', 'assets');
    const guids = new Set<string>();
    for (const raw of pack.assets) {
      const asset = raw as Partial<AssetEnvelopeV2<unknown>>;
      const guid = typeof asset.guid === 'string' ? asset.guid : '';
      if (guid.length === 0 || guids.has(guid.toLowerCase()))
        return invalid(guid, 'duplicate guid');
      guids.add(guid.toLowerCase());
      if (
        typeof asset.kind !== 'string' ||
        asset.payload === undefined ||
        !Array.isArray(asset.refs) ||
        asset.refs.some((ref) => typeof ref !== 'string') ||
        asset.artifacts === null ||
        typeof asset.artifacts !== 'object'
      ) {
        return invalid(guid, 'asset envelope fields');
      }
      for (const [artifactKey, descriptor] of Object.entries(asset.artifacts)) {
        if (!this.validArtifact(guid, artifactKey, descriptor)) {
          return invalid(guid, `artifact ${artifactKey}`);
        }
      }
    }
    return ok(frozen(pack as VerifiedPack));
  }

  private validArtifact(_guid: string, key: string, value: unknown): boolean {
    if (value === null || typeof value !== 'object') return false;
    const descriptor = value as Record<string, unknown>;
    const integrity = descriptor.integrity;
    return (
      key.length > 0 &&
      typeof descriptor.path === 'string' &&
      descriptor.path.length > 0 &&
      typeof descriptor.mediaType === 'string' &&
      descriptor.mediaType.length > 0 &&
      (descriptor.contentEncoding === 'identity' || descriptor.contentEncoding === 'zstd') &&
      Number.isSafeInteger(descriptor.byteLength) &&
      Number(descriptor.byteLength) >= 0 &&
      integrity !== null &&
      typeof integrity === 'object' &&
      (integrity as Record<string, unknown>).algorithm === 'sha256' &&
      typeof (integrity as Record<string, unknown>).digest === 'string' &&
      /^sha256:[0-9a-f]{64}$/i.test(String((integrity as Record<string, unknown>).digest))
    );
  }

  private cancelled(guid: string): AssetLoadError {
    return {
      code: 'asset-load-cancelled',
      expected: 'the request AbortSignal to remain live while reading the Pack',
      hint: 'retry with a live AbortSignal when the request is still needed',
      detail: { guid },
    };
  }
}

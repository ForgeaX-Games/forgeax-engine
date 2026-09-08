import type {
  Asset,
  AssetArtifactReader,
  AssetDecoder,
  AssetDecoderInput,
  AssetDecoderLease,
  AssetKind,
  AssetLoadError,
  BuiltinAssetKind,
  BuiltinAssetPayload,
  Result,
} from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import type { CatalogSource } from '../catalog-source.js';
import { ArtifactCache } from './artifact-cache.js';
import { AssetGraph, type AssetGraphSnapshot } from './asset-graph.js';
import { CatalogSession, type CatalogSessionOptions } from './catalog-session.js';
import { DecoderRegistry } from './decoder-registry.js';
import { freezeRuntimePayload } from './immutable-payload.js';
import { PackReader } from './pack-reader.js';
import { validateRuntimeRow } from './validate-runtime-row.js';

export interface AssetRegistryOptions extends CatalogSessionOptions {
  readonly catalog: CatalogSource;
  readonly fetcher?: typeof globalThis.fetch;
  readonly maxConcurrentReads?: number;
}

export interface AssetLoadOptions {
  readonly signal?: AbortSignal;
}

export type AssetRegistrySnapshot = AssetGraphSnapshot;

export type AssetRegistrySnapshotCounters = AssetRegistrySnapshot['counters'];

export interface AssetRegistry {
  installDecoder<P, K extends string>(
    kind: AssetKind<P, K>,
    decoder: AssetDecoder<P>,
  ): AssetDecoderLease;
  load<K extends BuiltinAssetKind>(
    guid: string,
    kind: K,
    options?: AssetLoadOptions,
  ): Promise<Result<BuiltinAssetPayload<K>, AssetLoadError>>;
  load<P, K extends string>(
    guid: string,
    kind: AssetKind<P, K>,
    options?: AssetLoadOptions,
  ): Promise<Result<P, AssetLoadError>>;
  snapshot(): AssetRegistrySnapshot;
  subscribe(listener: (snapshot: AssetRegistrySnapshot) => void): () => void;
  dispose(): void;
}

/** Internal render projection; the root Registry keeps only its five actions. */
export interface AssetRegistryResolver {
  readonly epoch: number;
  lookup<T extends Asset>(guid: string): T | undefined;
  guidOf(asset: Asset): string | undefined;
}

const REGISTRY_RESOLVER = Symbol.for('forgeax.assets-runtime.registry-resolver');
type RegistryWithResolver = AssetRegistry & {
  [REGISTRY_RESOLVER]?: AssetRegistryResolver;
};

export function getAssetRegistryResolver(registry: AssetRegistry): AssetRegistryResolver {
  const resolver = (registry as RegistryWithResolver)[REGISTRY_RESOLVER];
  if (resolver === undefined) {
    throw new TypeError('AssetRegistry resolver is not owned by this asset runtime');
  }
  return resolver;
}

function missing(guid: string): AssetLoadError {
  return {
    code: 'asset-not-found',
    expected: `the current Catalog to contain GUID "${guid}"`,
    hint: 'inspect the producer Catalog and rebuild the missing publication',
    detail: { guid },
  };
}

function mismatch(guid: string, expectedKind: string, actualKind: string): AssetLoadError {
  return {
    code: 'asset-kind-mismatch',
    expected: `Catalog kind "${actualKind}" to match "${expectedKind}"`,
    hint: 'pass the Catalog kind or the matching custom AssetKind token',
    detail: { guid, expectedKind, actualKind },
  };
}

function artifactError(guid: string, reason: string): AssetLoadError {
  return {
    code: 'asset-integrity-failed',
    expected: 'the verified artifact byte length and digest',
    hint: 'verify the artifact digest and recook the Pack',
    detail: {
      guid,
      artifactKey: reason,
      expectedDigest: 'descriptor integrity',
      actualDigest: reason,
    },
  };
}

const ASSET_GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function invalidGuid(guid: string): AssetLoadError {
  return {
    code: 'asset-guid-invalid',
    expected: 'a 36-character dash-form asset GUID',
    hint: 'pass the producer GUID from the current Catalog row',
    detail: { guid },
  };
}

export function createAssetRegistry(options: AssetRegistryOptions): AssetRegistry {
  const session = new CatalogSession(options.catalog, options);
  const reader = new PackReader(options.fetcher === undefined ? {} : { fetcher: options.fetcher });
  const cache = new ArtifactCache();
  const decoders = new DecoderRegistry(
    options.scopeId === undefined ? {} : { scopeId: options.scopeId },
  );
  const graph = new AssetGraph<{ readonly value: unknown; readonly refs: readonly string[] }>({
    ...(options.maxConcurrentReads === undefined
      ? {}
      : { maxConcurrentReads: options.maxConcurrentReads }),
    read: async (guid, signal) => {
      const row = session.current(guid);
      if (row === undefined) return err(missing(guid));
      const validated = validateRuntimeRow(row);
      if (!validated.ok) return validated;
      const publication = validated.value.publication;
      const tuple = {
        scopeId: session.snapshot().scopeId,
        generation: publication.generation,
        digest: publication.digest,
        outputSetDigest: publication.outputSetDigest,
      };
      const pack = await reader.read(row.packageUrl, tuple, signal);
      if (!pack.ok) return pack;
      const envelope = pack.value.assets.find(
        (asset) => asset.guid.toLowerCase() === guid.toLowerCase(),
      );
      if (envelope === undefined) return err(missing(guid));
      const artifacts: AssetArtifactReader = {
        read: (descriptor) => {
          const integrity = descriptor.integrity;
          if (integrity === undefined)
            return Promise.resolve(err(artifactError(guid, descriptor.path)));
          const key = `${tuple.scopeId}:${tuple.generation}:${tuple.outputSetDigest}:${integrity.digest}`;
          return cache.read(key, async () => {
            const url = resolveArtifactUrl(row.packageUrl, descriptor.path);
            let response: Response;
            try {
              response = await (options.fetcher ?? globalThis.fetch)(url, { signal });
            } catch {
              return err(artifactError(guid, descriptor.path));
            }
            if (!response.ok) return err(artifactError(guid, descriptor.path));
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (descriptor.byteLength === undefined || bytes.byteLength !== descriptor.byteLength) {
              return err(artifactError(guid, descriptor.path));
            }
            const actualDigest = await sha256(bytes);
            if (actualDigest !== descriptor.integrity?.digest.toLowerCase()) {
              return err(artifactError(guid, `${descriptor.path}:${actualDigest}`));
            }
            return ok(bytes);
          });
        },
      };
      const input: AssetDecoderInput<unknown> = { envelope, artifacts, signal };
      const decoded = await decoders.loadByKind(envelope.kind, input);
      if (!decoded.ok) return decoded;
      return ok({ value: freezeRuntimePayload(decoded.value), refs: envelope.refs });
    },
  });

  let catalogEpoch = session.snapshot().epoch;
  const unsubscribeCatalog = session.subscribe((snapshot) => {
    if (snapshot.epoch === catalogEpoch) return;
    catalogEpoch = snapshot.epoch;
    graph.invalidateForCatalogChange(
      snapshot.stale ? undefined : [...snapshot.changed, ...snapshot.removed],
    );
  });

  const registry: AssetRegistry = {
    installDecoder: (kind, decoder) => decoders.install(kind, decoder),
    load: (async (
      guid: string,
      kind: BuiltinAssetKind | AssetKind<unknown, string>,
      loadOptions: AssetLoadOptions = {},
    ): Promise<Result<unknown, AssetLoadError>> => {
      if (!ASSET_GUID_PATTERN.test(guid)) return err(invalidGuid(guid));
      const expectedKind = typeof kind === 'string' ? kind : kind.kind;
      const started = await session.start();
      if (!started.ok) return err(started.error);
      if (session.snapshot().stale) {
        const reconciled = await session.reconcile();
        if (!reconciled.ok) return err(reconciled.error);
        const discontinuity = session.discontinuity();
        if (discontinuity !== undefined) return err(discontinuity);
      }
      const row = session.current(guid);
      if (row === undefined) return err(missing(guid));
      if (row.kind !== expectedKind) return err(mismatch(guid, expectedKind, row.kind));
      const result = await graph.load(guid, loadOptions.signal);
      return result.ok ? ok(result.value.value) : result;
    }) as AssetRegistry['load'],
    snapshot: () => graph.snapshot(),
    subscribe: (listener) => graph.subscribe(listener),
    dispose: () => {
      graph.dispose();
      unsubscribeCatalog();
      decoders.dispose();
      cache.clear();
      session.dispose();
    },
  };
  const resolver: AssetRegistryResolver = {
    get epoch() {
      return graph.snapshot().epoch;
    },
    lookup: <T extends Asset>(guid: string) => graph.lookup(guid) as T | undefined,
    guidOf: (asset: Asset) => graph.guidOf(asset),
  };
  Object.defineProperty(registry, REGISTRY_RESOLVER, {
    value: resolver,
    enumerable: false,
  });
  return registry;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource);
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

function resolveArtifactUrl(packageUrl: string, path: string): string {
  const separator = packageUrl.lastIndexOf('/');
  const packageDirectory = separator < 0 ? '' : packageUrl.slice(0, separator + 1);
  try {
    return new URL(path, packageDirectory).toString();
  } catch {
    return `${packageDirectory}${path.replace(/^\//, '')}`;
  }
}

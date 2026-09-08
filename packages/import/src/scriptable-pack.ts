import { isScriptablePackAssetKind, type ScriptablePackAssetKind } from '@forgeax/engine-pack';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import {
  type AssetReader,
  projectScriptablePackMeta,
  projectScriptablePackSceneComponents,
  type ScriptablePackDefinition,
  type ScriptablePackError,
  type ScriptablePackReadError,
  type ScriptablePackSourceClosureEntry,
} from '@forgeax/engine-pack/source';
import type {
  AnimationGraph,
  Asset,
  AssetGuid as AssetGuidType,
  AssetPublicationEnvelope,
  FontAsset,
  ImportedAsset,
  MaterialAsset,
  MeshAsset,
  Result,
  TilesetAsset,
} from '@forgeax/engine-types';

export type { ScriptablePackSourceClosureEntry } from '@forgeax/engine-pack/source';

import { AssetError, err, ImportError, ok } from '@forgeax/engine-types';
import {
  createImportProduct,
  type ImportAssetProduct,
  type TerminalImportProduct,
} from './import-product.js';

function commonPathPrefix(paths: readonly string[]): string {
  const first = paths[0];
  if (first === undefined) return '';
  const firstNormalized = first.replaceAll('\\', '/');
  const firstDirectory = firstNormalized.slice(0, firstNormalized.lastIndexOf('/'));
  const parts = firstDirectory.split('/');
  let length = parts.length;
  for (const path of paths.slice(1)) {
    const normalized = path.replaceAll('\\', '/');
    const candidate = normalized.slice(0, normalized.lastIndexOf('/')).split('/');
    length = Math.min(length, candidate.length);
    for (let index = 0; index < length; index += 1) {
      if (parts[index] !== candidate[index]) {
        length = index;
        break;
      }
    }
  }
  return parts.slice(0, length).join('/');
}

/** Remove host-specific absolute roots from the source closure fingerprint. */
function stableSourceClosure(
  closure: readonly ScriptablePackSourceClosureEntry[],
): readonly ScriptablePackSourceClosureEntry[] {
  const root = commonPathPrefix(closure.map((entry) => entry.path));
  return closure
    .map((entry) => ({
      path: entry.path.replaceAll('\\', '/').slice(root.length).replace(/^\/+/, ''),
      digest: entry.digest,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

export interface ScriptablePackAssetSnapshot {
  readonly asset: Asset;
  readonly generation: number;
  readonly digest: string;
}

export interface ScriptablePackStagedOutput {
  readonly guid: AssetGuidType;
  /** Producer-owned stable output identity from the ScriptablePack definition. */
  readonly sourceKey?: string;
  readonly asset: Asset;
  readonly digest?: string;
}

export interface ScriptablePackAssetSnapshotSource {
  readByGuid(
    guid: AssetGuidType,
  ): Promise<Result<ScriptablePackAssetSnapshot, ScriptablePackReadError>>;
}

export interface AssetOutputInput {
  readonly guid: string;
  readonly sourceKey: string;
  readonly asset: Asset;
}

type MaterialPackPayload = Omit<MaterialAsset, 'parent' | 'values'> & {
  readonly parent?: number;
  readonly values?: Readonly<Record<string, unknown>>;
};

type ScenePackPayload = { readonly kind: 'scene'; readonly [key: string]: unknown };

type FontPackPayload = Omit<FontAsset, 'atlas' | 'sampler'> & {
  readonly atlasGuid: string;
  readonly samplerGuid: string;
};

type TilesetPackPayload = Omit<TilesetAsset, 'atlases'> & { readonly atlases: readonly number[] };

type AnimationGraphPackPayload = Omit<AnimationGraph, 'nodes'> & {
  readonly nodes: readonly (
    | Exclude<AnimationGraph['nodes'][number], { readonly type: 'clip' }>
    | (Omit<Extract<AnimationGraph['nodes'][number], { readonly type: 'clip' }>, 'clip'> & {
        readonly clip: number;
      })
  )[];
};

/** Serialized Pack projection; durable runtime Assets never carry ref indices. */
export type AssetOutputPayloadByKind = {
  readonly mesh: MeshAsset;
  readonly material: MaterialPackPayload;
  readonly scene: ScenePackPayload;
  readonly texture: Extract<Asset, { readonly kind: 'texture' }>;
  readonly equirect: Extract<Asset, { readonly kind: 'equirect' }>;
  readonly sampler: Extract<Asset, { readonly kind: 'sampler' }>;
  readonly font: FontPackPayload;
  readonly 'render-pipeline': Extract<Asset, { readonly kind: 'render-pipeline' }>;
  readonly tileset: TilesetPackPayload;
  readonly video: Extract<Asset, { readonly kind: 'video' }>;
  readonly skeleton: Extract<Asset, { readonly kind: 'skeleton' }>;
  readonly skin: Extract<Asset, { readonly kind: 'skin' }>;
  readonly 'animation-clip': Extract<Asset, { readonly kind: 'animation-clip' }>;
  readonly 'animation-graph': AnimationGraphPackPayload;
  readonly audio: Extract<Asset, { readonly kind: 'audio' }>;
  readonly 'particle-effect': Extract<Asset, { readonly kind: 'particle-effect' }>;
};

export type AssetOutputPayload = AssetOutputPayloadByKind[ScriptablePackAssetKind];

export type AssetOutputProduct = ImportAssetProduct<AssetOutputPayload>;

export interface AssetOutputProducer {
  readonly kind: string;
  readonly version: string;
  produce(
    input: AssetOutputInput,
  ): Result<AssetOutputProduct, ImportError> | Promise<Result<AssetOutputProduct, ImportError>>;
}

export class AssetOutputProducerRegistry {
  private readonly producers = new Map<string, AssetOutputProducer>();

  register(producer: AssetOutputProducer): void {
    if (producer.kind.trim().length === 0 || producer.version.trim().length === 0) {
      throw new TypeError('ScriptablePack output producer kind and version must be non-empty');
    }
    if (typeof producer.produce !== 'function') {
      throw new TypeError(`ScriptablePack output producer ${producer.kind} must expose produce`);
    }
    this.producers.set(producer.kind, producer);
  }

  get(kind: string): AssetOutputProducer | undefined {
    return this.producers.get(kind);
  }

  versions(): Readonly<Record<string, string>> {
    return Object.fromEntries(
      [...this.producers.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([kind, producer]) => [kind, producer.version]),
    );
  }
}

export type ScriptablePackExternalUsage = 'reference' | 'content' | 'both';

export interface ScriptablePackExternalEvidence {
  readonly guid: string;
  readonly usage: ScriptablePackExternalUsage;
  readonly generation?: number;
  readonly digest?: string;
}

export interface ScriptablePackBuildProduct {
  readonly product: TerminalImportProduct<unknown>;
  /** Raw private outputs for the current staged build generation, never a runtime publication path. */
  readonly stagedOutputs: readonly ScriptablePackStagedOutput[];
  readonly externalEvidence: readonly ScriptablePackExternalEvidence[];
  readonly inputFingerprint: string;
  /** Engine publication fields projected after ordinary producers run. */
  readonly publication?: AssetPublicationEnvelope;
}

/** Domain-owned structured failure transported without flattening its recovery fields. */
export interface ScriptablePackDomainError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
}

export type ScriptablePackBuildBridgeResult = Result<
  ScriptablePackBuildProduct,
  ScriptablePackError | AssetError | ImportError | ScriptablePackDomainError
>;

interface ObservedRead {
  readonly guid: string;
  readonly asset: Asset;
  readonly generation: number;
  readonly digest: string;
}

function privateClone<T>(value: T): T {
  return structuredClone(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAsset(value: unknown): value is Asset {
  return record(value) && typeof value.kind === 'string' && isScriptablePackAssetKind(value.kind);
}

function isStructuredDomainError(value: unknown): value is ScriptablePackDomainError {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { readonly code?: unknown }).code === 'string' &&
    typeof (value as { readonly expected?: unknown }).expected === 'string' &&
    typeof (value as { readonly hint?: unknown }).hint === 'string'
  );
}

function remapBuildFailureSource(
  value: unknown,
  sourcePath: string,
): ScriptablePackError | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const error = value as { readonly code?: unknown; readonly detail?: unknown };
  if (error.code !== 'pack-source-load-failed') return undefined;
  if (error.detail === null || typeof error.detail !== 'object') return undefined;
  const detail = error.detail as { readonly phase?: unknown } & Record<string, unknown>;
  if (detail.phase !== 'build') return undefined;
  return {
    ...(value as ScriptablePackError),
    detail: { ...detail, sourcePath },
  } as ScriptablePackError;
}

function observedAssetReader(source?: ScriptablePackAssetSnapshotSource): {
  readonly reader: AssetReader;
  readonly reads: ReadonlyMap<string, ObservedRead>;
} {
  const reads = new Map<string, ObservedRead>();
  const reader: AssetReader = {
    async readByGuid<TAsset extends Asset = Asset>(guid: AssetGuidType) {
      const key = AssetGuid.format(guid);
      const cached = reads.get(key);
      if (cached !== undefined) return ok(privateClone(cached.asset) as TAsset);
      if (source === undefined) {
        return err(
          new AssetError({
            code: 'asset-not-found',
            expected: `a host Asset snapshot source for ScriptablePack content read ${key}`,
            hint: 'configure the standard ScriptablePack asset source or remove the content read',
          }),
        );
      }
      const result = await source.readByGuid(guid);
      if (!result.ok) return result;
      const fixed = privateClone(result.value.asset);
      reads.set(key, {
        guid: key,
        asset: fixed,
        generation: result.value.generation,
        digest: result.value.digest,
      });
      return ok(privateClone(fixed) as TAsset);
    },
  };
  return { reader, reads };
}

function stable(value: unknown): string {
  if (value instanceof Uint8Array) return JSON.stringify(Array.from(value));
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

async function fingerprint(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined)
    throw new Error('Web Crypto API is required for ScriptablePack fingerprints');
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(stable(value)));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `sha256:${hex}`;
}

function outputError(
  definition: ScriptablePackDefinition,
  output: Readonly<Record<string, unknown>>,
): ScriptablePackError | undefined {
  const declaredKeys = Object.keys(definition.assets);
  const outputKeys = Object.keys(output);
  const outputKeySet = new Set(outputKeys);
  const declaredKeySet = new Set(declaredKeys);
  const missingKeys = declaredKeys.filter((key) => !outputKeySet.has(key));
  const unexpectedSourceKeys = outputKeys.filter((key) => !declaredKeySet.has(key));
  const kindMismatches = declaredKeys.flatMap((sourceKey) => {
    const descriptor = definition.assets[sourceKey];
    const value = output[sourceKey];
    if (descriptor === undefined || value === undefined) return [];
    const actualKind =
      value !== null && typeof value === 'object' && 'kind' in value
        ? String((value as { readonly kind: unknown }).kind)
        : typeof value;
    return actualKind === descriptor.kind
      ? []
      : [{ sourceKey, expected: descriptor.kind, actual: actualKind }];
  });
  if (
    missingKeys.length === 0 &&
    unexpectedSourceKeys.length === 0 &&
    kindMismatches.length === 0
  ) {
    return undefined;
  }
  return {
    code: 'pack-source-output-invalid',
    expected: 'build output keys and kinds to exactly match definition.assets',
    hint: 'inspect sourceKey and GUID topology, then rebuild or cold-cook the ScriptablePack',
    detail: {
      missingGuids: missingKeys.map((key) =>
        AssetGuid.format(definition.assets[key]?.guid as AssetGuidType),
      ),
      unexpectedSourceKeys,
      kindMismatches,
    },
  };
}

function externalClosureError(
  declared: ReadonlySet<string>,
  referenced: ReadonlySet<string>,
  read: ReadonlySet<string>,
): ScriptablePackError | undefined {
  const used = new Set([...referenced, ...read]);
  const undeclaredReferencedGuids = [...referenced].filter((guid) => !declared.has(guid));
  const undeclaredReadGuids = [...read].filter((guid) => !declared.has(guid));
  const unusedDeclaredGuids = [...declared].filter((guid) => !used.has(guid));
  if (
    undeclaredReferencedGuids.length === 0 &&
    undeclaredReadGuids.length === 0 &&
    unusedDeclaredGuids.length === 0
  ) {
    return undefined;
  }
  return {
    code: 'pack-source-external-closure-mismatch',
    expected: 'externalAssets GUIDs to equal output external refs union AssetReader reads',
    hint: 'inspect refs and AssetReader reads, repair GUID declarations, then rebuild or cold-cook',
    detail: {
      undeclaredReferencedGuids: undeclaredReferencedGuids.sort(),
      undeclaredReadGuids: undeclaredReadGuids.sort(),
      unusedDeclaredGuids: unusedDeclaredGuids.sort(),
    },
  };
}

function productContractError(
  sourceKey: string,
  kind: string,
  product: AssetOutputProduct,
): ScriptablePackError | undefined {
  const mismatches: { sourceKey: string; expected: string; actual: string }[] = [];
  if (product.payload.kind !== kind) {
    mismatches.push({ sourceKey, expected: kind, actual: product.payload.kind });
  }
  for (const reference of product.refs) {
    if (!AssetGuid.parse(reference.guid).ok) {
      mismatches.push({
        sourceKey,
        expected: 'every producer ref to contain a valid Asset GUID',
        actual: reference.guid,
      });
      break;
    }
  }
  for (const [artifactKey, artifact] of Object.entries(product.artifacts)) {
    if (
      artifactKey.length === 0 ||
      artifactKey.startsWith('/') ||
      artifactKey.includes('..') ||
      artifactKey.includes('\\') ||
      artifact.mediaType.trim().length === 0 ||
      !(artifact.bytes instanceof Uint8Array)
    ) {
      mismatches.push({
        sourceKey,
        expected: 'asset-local artifacts with safe keys, mediaType, and Uint8Array bytes',
        actual: artifactKey,
      });
      break;
    }
  }
  if (mismatches.length === 0) return undefined;
  return {
    code: 'pack-source-output-invalid',
    expected: 'producer output refs and asset-local artifacts to satisfy the Pack v2 contract',
    hint: 'inspect sourceKey and artifact provenance, repair refs or bytes, then rebuild or cold-cook',
    detail: { missingGuids: [], unexpectedSourceKeys: [], kindMismatches: mismatches },
  };
}

export interface BuildScriptablePackOptions {
  readonly definition: ScriptablePackDefinition;
  readonly sourcePath: string;
  readonly assetSource?: ScriptablePackAssetSnapshotSource;
  readonly outputs: AssetOutputProducerRegistry;
  readonly sourceClosure: readonly ScriptablePackSourceClosureEntry[];
  readonly authoringContractVersion: string;
}

/**
 * Build one external ScriptablePack through the producer-owned Pack bridge.
 * Success preserves payloads, GUID refs, and local artifacts; failure retains
 * `code`, `expected`, `hint`, and `detail` for recovery by the caller.
 */
export async function buildScriptablePack(
  options: BuildScriptablePackOptions,
): Promise<ScriptablePackBuildBridgeResult> {
  const observed = observedAssetReader(options.assetSource);
  let built: Awaited<ReturnType<ScriptablePackDefinition['build']>>;
  try {
    const build = options.definition.build;
    built = await build(observed.reader);
  } catch (error) {
    return err(
      new ImportError({
        code: 'import-internal-error',
        expected: 'ScriptablePack build to return a structured Result without throwing',
        hint: 'fix the build implementation and return a structured failure for expected authoring errors',
        detail: { reason: error instanceof Error ? error.message : String(error) },
      }),
    );
  }
  if (!built.ok) {
    const remappedBuildFailure = remapBuildFailureSource(built.error, options.sourcePath);
    if (remappedBuildFailure !== undefined) return err(remappedBuildFailure);
    if (
      built.error instanceof ImportError ||
      built.error instanceof AssetError ||
      isStructuredDomainError(built.error)
    ) {
      return err(built.error);
    }
    return err(
      new ImportError({
        code: 'import-internal-error',
        expected: 'ScriptablePack build failure to use a structured domain error',
        hint: 'return an error with code, expected, hint, and optional detail fields',
        detail: { reason: String(built.error) },
      }),
    );
  }
  if (!record(built.value)) {
    return err(
      new ImportError({
        code: 'import-internal-error',
        expected: 'ScriptablePack build output to be an object keyed by declared sourceKey',
        hint: 'return one concrete Asset payload for each declared sourceKey',
        detail: { reason: 'build output is not an object' },
      }),
    );
  }
  const output = built.value;
  const invalidOutput = outputError(options.definition, output);
  if (invalidOutput !== undefined) return err(invalidOutput);

  const assets: ImportedAsset<unknown>[] = [];
  for (const sourceKey of Object.keys(options.definition.assets).sort()) {
    const descriptor = options.definition.assets[sourceKey];
    const asset = output[sourceKey];
    if (descriptor === undefined) continue;
    if (!isAsset(asset)) {
      return err(
        new ImportError({
          code: 'import-internal-error',
          expected: `a concrete Asset payload for sourceKey ${sourceKey}`,
          hint: 'return a durable Asset with a kind from SCRIPTABLE_PACK_ASSET_KINDS',
          detail: { reason: 'build output payload is missing or has an unknown kind' },
        }),
      );
    }
    const producer = options.outputs.get(descriptor.kind);
    if (producer === undefined) {
      return err({
        code: 'pack-source-output-invalid',
        expected: `a domain output producer registered for kind ${descriptor.kind}`,
        hint: 'attach the owning producer capability, inspect registration, then rebuild or cold-cook',
        detail: {
          missingGuids: [AssetGuid.format(descriptor.guid)],
          unexpectedSourceKeys: [],
          kindMismatches: [],
        },
      });
    }
    const product = await producer.produce({
      guid: AssetGuid.format(descriptor.guid),
      sourceKey,
      asset,
    });
    if (!product.ok) return err(product.error);
    const productError = productContractError(sourceKey, descriptor.kind, product.value);
    if (productError !== undefined) return err(productError);
    assets.push({
      guid: AssetGuid.format(descriptor.guid),
      kind: descriptor.kind,
      ...(descriptor.name === undefined ? {} : { name: descriptor.name }),
      payload: product.value.payload,
      refs: product.value.refs,
      artifacts: product.value.artifacts,
    });
  }

  const local = new Set(assets.map((asset) => asset.guid.toLowerCase()));
  const referenced = new Set(
    assets
      .flatMap((asset) => asset.refs.map((reference) => reference.guid.toLowerCase()))
      .filter((guid) => !local.has(guid)),
  );
  const read = new Set([...observed.reads.keys()].map((guid) => guid.toLowerCase()));
  const declared = new Set(
    Object.values(options.definition.externalAssets).map((guid) =>
      AssetGuid.format(guid).toLowerCase(),
    ),
  );
  const closureError = externalClosureError(declared, referenced, read);
  if (closureError !== undefined) return err(closureError);

  const externalEvidence = [...declared].sort().map((guid): ScriptablePackExternalEvidence => {
    const observedRead = observed.reads.get(guid);
    const isReference = referenced.has(guid);
    return {
      guid,
      usage: observedRead === undefined ? 'reference' : isReference ? 'both' : 'content',
      ...(observedRead === undefined
        ? {}
        : { generation: observedRead.generation, digest: observedRead.digest }),
    };
  });
  // The dependency generation is runtime provenance, not a content identity.
  // It may advance when a fresh AssetRegistry is created even though the
  // referenced bytes are unchanged. Keep it in the receipt for diagnostics,
  // but exclude it from the source fingerprint so an identical source closure
  // and dependency digest produce the same publication fence across Edit and
  // fresh Play worlds.
  const fingerprintEvidence = externalEvidence.map(({ guid, usage, digest }) => ({
    guid,
    usage,
    ...(digest === undefined ? {} : { digest }),
  }));
  const inputFingerprint = await fingerprint({
    meta: projectScriptablePackMeta(options.definition, options.sourcePath),
    sceneComponents: projectScriptablePackSceneComponents(options.definition.sceneComponents),
    sourceClosure: stableSourceClosure(options.sourceClosure),
    externalEvidence: fingerprintEvidence,
    authoringContractVersion: options.authoringContractVersion,
    producerVersions: options.outputs.versions(),
  });
  const refs = assets.flatMap((asset) => asset.refs);
  const artifacts = Object.fromEntries(
    assets.flatMap((asset) =>
      Object.entries(asset.artifacts).map(([key, artifact]) => [`${asset.guid}/${key}`, artifact]),
    ),
  );
  const product = createImportProduct({
    assets,
    sourceDependencies: options.sourceClosure.map((entry) => entry.path),
    refs,
    artifacts,
    receipts: assets.map((asset) => ({
      guid: asset.guid,
      origin: 'sourceMeta' as const,
      status: 'succeeded' as const,
      inputFingerprint,
    })),
    diagnostics: [],
    sourceRevision: inputFingerprint,
    sourceKey: options.sourcePath,
  });
  if (!product.ok) return err(product.error);
  return ok({
    product: product.value,
    stagedOutputs: await Promise.all(
      Object.keys(options.definition.assets)
        .sort()
        .map(async (sourceKey) => {
          const descriptor = options.definition.assets[sourceKey];
          const asset = output[sourceKey];
          if (descriptor === undefined || !isAsset(asset)) {
            throw new Error(`validated ScriptablePack output ${sourceKey} is not an Asset`);
          }
          return {
            guid: descriptor.guid,
            sourceKey,
            asset: privateClone(asset),
            digest: await fingerprint(asset),
          };
        }),
    ),
    externalEvidence,
    inputFingerprint,
  });
}

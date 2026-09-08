import { resolve } from 'node:path';
import {
  type CatalogBuildResult,
  createRuntimePackPublication,
  finalizePackageTransportSource,
  loadAssetConfig,
  metaPathForGuid,
  projectCookedPackageEntry,
} from '@forgeax/engine-pack/build';
import type { NativeCooker } from '@forgeax/engine-pack/native-cooker';
import type {
  AssetPublicationEnvelope,
  Importer,
  PackIndexEntry,
  ResourceRevision,
  RuntimeAssetBinding,
} from '@forgeax/engine-types';
import type { ImportRunnerFs } from './import-runner.js';
import type { ImporterRegistry } from './importer-registry.js';
import { projectImportProductForBuild } from './pack-projection.js';
import {
  canonicalScriptableSourcePath,
  declaredPackExternalOutputs,
  materializePreparedScriptablePack,
  prepareAuthoredPackTransport,
  produceScriptablePackProducts,
  scriptablePackInputs,
} from './scriptable-pack-host.js';
import {
  finalizeSourcePackage,
  produceSourcePackage,
  sourcePackageAssetsByGuid,
} from './source-package.js';

export interface BuildProductionFailure {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail?: unknown;
  readonly cause?: unknown;
}

export interface BuildProductionFile {
  readonly type: 'asset';
  readonly fileName?: string;
  readonly name?: string;
  readonly originalFileName?: string;
  readonly source: string | Uint8Array;
}

export interface BuildProductionSink {
  emitFile(file: BuildProductionFile): string;
  getFileName(referenceId: string): string;
  fileUrl(fileName: string): string;
}

export interface BuildProductionOptions {
  readonly inventory: CatalogBuildResult;
  readonly cwd: string;
  readonly basePrefix: string;
  readonly generation: number;
  readonly cookers: readonly NativeCooker[];
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
  readonly cookedCurrentProjection: Record<string, unknown>;
  readonly directCurrentProjection: Record<string, unknown>;
  readonly authoredCookedCurrentProjection: Record<string, unknown>;
  readonly runtimeBinding?: Pick<RuntimeAssetBinding, 'scopeId' | 'generation'>;
  readonly sink: BuildProductionSink;
  readonly fail: (failure: BuildProductionFailure) => Error;
}

export interface ScriptableBuildPackage {
  readonly packageUrl: string;
  readonly receiptUrls: ReadonlyMap<string, string>;
  readonly refs: ReadonlyMap<string, readonly string[]>;
  readonly revision: ResourceRevision;
  readonly publication: AssetPublicationEnvelope;
}

function scriptableArtifactPath(guid: string, key: string): string {
  return `${guid.toLowerCase()}/${key.includes('.') ? key : `${key}.bin`}`;
}

function runtimePublicationFor(
  context: BuildProductionOptions,
  input: {
    readonly pack: Parameters<typeof createRuntimePackPublication>[0]['pack'];
    readonly sourcePath: string;
    readonly sourceRevision: string;
    readonly packageUrl: string;
    readonly digest?: string;
  },
) {
  return createRuntimePackPublication({
    pack: input.pack,
    scopeId: context.runtimeBinding?.scopeId ?? 'asset-runtime',
    sourcePath: input.sourcePath,
    sourceRevision: input.sourceRevision,
    packageUrl: input.packageUrl,
    ...(input.digest === undefined ? {} : { digest: input.digest }),
    generation: context.runtimeBinding?.generation ?? context.generation,
  });
}

async function buildAuthoredPackages(
  context: BuildProductionOptions,
): Promise<ReadonlyMap<string, ScriptableBuildPackage>> {
  const scriptableSources = [
    ...new Set(
      context.inventory.entries
        .filter((entry) => entry.sourcePath.endsWith('.pack.ts'))
        .map((entry) => entry.sourcePath),
    ),
  ];
  if (scriptableSources.length === 0) return new Map();
  const inputs = scriptablePackInputs(
    scriptableSources,
    context.inventory.sourceDeclarations,
    context.cwd,
    () => context.generation,
    () => (product) => ({
      base: context.basePrefix === '' ? '/' : context.basePrefix,
      packagePath: `assets/${product.anchorGuid}.pack.json`,
      artifactPath: scriptableArtifactPath,
    }),
  );
  const preparedResult = await produceScriptablePackProducts(
    inputs,
    await declaredPackExternalOutputs(
      context.inventory.sourceDeclarations,
      context.cookers,
      inputs.flatMap((input) => Object.values(input.definition.externalAssets)),
      {
        importerRegistry: context.importerRegistry,
        fsForImport: context.fsForImport,
        assetPaths: loadAssetConfig(context.cwd).paths,
      },
    ),
  );
  if (!preparedResult.ok) throw context.fail(preparedResult.error);

  const result = new Map<string, ScriptableBuildPackage>();
  for (const entry of context.inventory.entries) {
    if (!entry.sourcePath.endsWith('.pack.ts') || result.has(entry.sourcePath)) continue;
    const prepared = preparedResult.value.get(canonicalScriptableSourcePath(entry.sourcePath));
    if (prepared === undefined) {
      throw context.fail({
        code: 'catalog-declaration-missing',
        expected: 'the ScriptablePack inventory to retain every authored Pack source',
        hint: 'rerun the source inventory and rebuild from the accepted declaration set',
        detail: { stage: 'scan', sourcePath: entry.sourcePath },
      });
    }
    const { product, finalized, facts, revision, publication } = prepared;
    const packagePath = `assets/${product.anchorGuid}.pack.json`;
    const runtimePublication = createRuntimePackPublication({
      pack: { assets: finalized.pack.assets },
      scopeId: context.runtimeBinding?.scopeId ?? 'asset-runtime',
      sourcePath: publication.sourcePath,
      sourceRevision: publication.sourceRevision,
      packageUrl: finalized.packageUrl,
      inputFingerprint: publication.receipt.inputFingerprint,
      digest: finalized.digest,
      generation: context.runtimeBinding?.generation ?? publication.generation,
      outputs: facts.outputs,
      externalEvidence: publication.externalEvidence,
    });
    const receiptPaths = await materializePreparedScriptablePack(
      prepared,
      {
        packagePath,
        artifactPath: (path) => `assets/${path}`,
        receiptPath: (guid) => `assets/${guid}.receipt.json`,
      },
      {
        writePackage: (path) => {
          context.sink.emitFile({
            type: 'asset',
            fileName: path,
            originalFileName: `${context.cwd}/${entry.sourcePath}`,
            source: JSON.stringify(runtimePublication.pack),
          });
        },
        writeArtifact: (path, bytes) => {
          context.sink.emitFile({ type: 'asset', fileName: path, source: bytes });
        },
        writeReceipt: (path, source) => {
          context.sink.emitFile({ type: 'asset', fileName: path, source });
        },
      },
    );
    result.set(entry.sourcePath, {
      packageUrl: finalized.packageUrl,
      receiptUrls: new Map(
        [...receiptPaths].map(([guid, path]) => [guid, context.sink.fileUrl(path)]),
      ),
      revision,
      publication: runtimePublication.publication,
      refs: facts.refs,
    });
  }
  return result;
}

function updateImportedEntries(
  entries: PackIndexEntry[],
  guids: readonly string[],
  packageUrl: string,
  projection: Record<string, unknown> = {},
  refsByGuid?: ReadonlyMap<string, readonly string[]>,
  publication?: AssetPublicationEnvelope,
): void {
  const selected = new Set(guids.map((guid) => guid.toLowerCase()));
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || !selected.has(entry.guid.toLowerCase())) continue;
    const refs = refsByGuid?.get(entry.guid.toLowerCase());
    entries[index] = {
      ...entry,
      packageUrl,
      ...projection,
      ...(publication === undefined ? {} : { publication }),
      ...(refs === undefined ? {} : { refs }),
    };
  }
}

interface BuildEmissionWork {
  readonly importedEntries: PackIndexEntry[];
  readonly context: BuildProductionOptions;
}

interface PackEmissionOptions {
  readonly pack: unknown;
  readonly artifacts: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  readonly packageName: string;
  readonly originalFileName: string;
  readonly guids: readonly string[];
  readonly projection?: Record<string, unknown>;
  readonly refsByGuid?: ReadonlyMap<string, readonly string[]>;
  readonly publication?: AssetPublicationEnvelope;
}

async function emitPackDocument(
  work: BuildEmissionWork,
  options: PackEmissionOptions,
): Promise<string> {
  for (const artifact of options.artifacts) {
    work.context.sink.emitFile({
      type: 'asset',
      fileName: `assets/${artifact.path}`,
      source: artifact.bytes,
    });
  }
  const referenceId = work.context.sink.emitFile({
    type: 'asset',
    name: options.packageName,
    originalFileName: options.originalFileName,
    source: JSON.stringify(options.pack),
  });
  const packageUrl = work.context.sink.fileUrl(work.context.sink.getFileName(referenceId));
  updateImportedEntries(
    work.importedEntries,
    options.guids,
    packageUrl,
    options.projection,
    options.refsByGuid,
    options.publication,
  );
  return packageUrl;
}

async function emitAuthoredPack(
  work: BuildEmissionWork,
  guidSeen: Set<string>,
  entry: PackIndexEntry,
): Promise<void> {
  const packPath = resolve(work.context.cwd, entry.sourcePath);
  const declaration = work.context.inventory.sourceDeclarations.get(packPath);
  if (declaration?.format !== 'pack.json') {
    throw work.context.fail({
      code: 'catalog-declaration-missing',
      expected: 'the inventory to retain the authored Pack declaration',
      hint: 'rerun Pack inventory before emitting the authored Pack',
      detail: { stage: 'scan', sourcePath: packPath },
    });
  }
  const prepared = await prepareAuthoredPackTransport(
    declaration.value,
    work.context.cookers,
    (guid) => ({
      base: work.context.basePrefix === '' ? '/' : work.context.basePrefix,
      packagePath: `assets/${guid}.pack.json`,
      artifactPath: (artifactGuid, key) => `${artifactGuid}/${key}.bin`,
    }),
    packPath,
  );
  const outputGuid = prepared.firstGuid ?? entry.guid;
  const authoredPack = prepared.finalized?.pack ?? prepared.pack;
  const runtimePublication =
    authoredPack.assets === undefined || authoredPack.assets.length === 0
      ? undefined
      : runtimePublicationFor(work.context, {
          pack: { assets: authoredPack.assets },
          sourcePath: packPath,
          sourceRevision: prepared.finalized?.sourceRevision ?? entry.sourcePath,
          packageUrl:
            prepared.finalized?.packageUrl ??
            `${work.context.basePrefix === '/' ? '' : work.context.basePrefix}/assets/${outputGuid}.pack.json`,
          ...(prepared.finalized?.digest === undefined
            ? {}
            : { digest: prepared.finalized.digest }),
        });
  await emitPackDocument(work, {
    pack: runtimePublication?.pack ?? authoredPack,
    artifacts: prepared.finalized?.artifacts ?? [],
    packageName: `${outputGuid}.pack.json`,
    originalFileName: packPath,
    guids: prepared.pack.assets?.map((asset) => asset.guid) ?? [outputGuid],
    projection:
      prepared.finalized === undefined
        ? work.context.directCurrentProjection
        : work.context.authoredCookedCurrentProjection,
    ...(prepared.cooked === undefined ? {} : { refsByGuid: prepared.cooked.refsByGuid }),
    ...(runtimePublication === undefined ? {} : { publication: runtimePublication.publication }),
  });
  for (const guid of prepared.pack.assets?.map((asset) => asset.guid) ?? [outputGuid]) {
    guidSeen.add(guid.toLowerCase());
  }
}

async function emitFinalizedOwner(
  work: BuildEmissionWork,
  metaPath: string,
  subAssets: readonly { readonly guid: string }[],
  sourcePackage: Extract<
    Awaited<ReturnType<typeof produceSourcePackage>>,
    { readonly ok: true }
  >['value'],
  ownerFinalizer: NonNullable<Importer['finalize']>,
): Promise<void> {
  const ownerGuid = subAssets[0]?.guid;
  if (ownerGuid === undefined) return;
  const artifactPaths = new Map<string, string>();
  const sourceAsset = sourcePackage.product.assets[0];
  for (const [path, artifact] of Object.entries(sourceAsset?.artifacts ?? {})) {
    const ref = work.context.sink.emitFile({
      type: 'asset',
      name: path,
      originalFileName: path,
      source: artifact.bytes,
    });
    artifactPaths.set(path, work.context.sink.getFileName(ref));
  }
  const ownerProduct = finalizeSourcePackage(sourcePackage.product, ownerFinalizer, (artifact) =>
    work.context.sink.fileUrl(artifactPaths.get(artifact.path) ?? artifact.path),
  );
  if (!ownerProduct.ok) throw work.context.fail(ownerProduct.error);
  const ownerPackage = await finalizePackageTransportSource(
    projectImportProductForBuild(ownerProduct.value),
    {
      base: work.context.basePrefix,
      packagePath: `assets/${ownerGuid}.pack.json`,
      artifactPath: (_guid, key) => {
        const emittedPath = artifactPaths.get(key);
        if (emittedPath === undefined) {
          throw work.context.fail({
            code: 'producer-artifact-missing',
            expected: `producer artifact ${key} to be emitted before Pack finalization`,
            hint: 'repair the importer finalizer artifact closure and rebuild',
            detail: { stage: 'finalize', metaPath, artifact: key },
          });
        }
        return emittedPath.replace(/^assets\//, '');
      },
      sink: () => {},
    },
  );
  const runtimePublication = runtimePublicationFor(work.context, {
    pack: { assets: ownerPackage.pack.assets },
    sourcePath: metaPath,
    sourceRevision: ownerPackage.sourceRevision,
    packageUrl: ownerPackage.packageUrl,
    digest: ownerPackage.digest,
  });
  await emitPackDocument(work, {
    pack: runtimePublication.pack,
    artifacts: ownerPackage.artifacts,
    packageName: `${ownerGuid}.pack.json`,
    originalFileName: metaPath,
    guids: subAssets.map((sub) => sub.guid),
    projection: work.context.cookedCurrentProjection,
    refsByGuid: new Map(
      ownerProduct.value.assets.map((asset) => [
        asset.guid.toLowerCase(),
        asset.refs.map((ref) => ref.guid),
      ]),
    ),
    publication: runtimePublication.publication,
  });
}

async function emitBuildEntry(
  work: BuildEmissionWork,
  guidSeen: Set<string>,
  entry: PackIndexEntry,
): Promise<void> {
  const guid = entry.guid.toLowerCase();
  const metaPath = metaPathForGuid(work.context.inventory.declarations, guid);
  if (metaPath === undefined) {
    if (entry.sourcePath.endsWith('.pack.json')) await emitAuthoredPack(work, guidSeen, entry);
    else guidSeen.add(guid);
    return;
  }
  const declaration = work.context.inventory.declarations.get(metaPath);
  if (declaration === undefined) {
    throw work.context.fail({
      code: 'catalog-declaration-missing',
      expected: 'every indexed Meta path to have one validated producer declaration',
      hint: 'rerun the inventory and repair the Catalog declaration index',
      detail: { metaPath },
    });
  }
  const runMeta = { ...declaration, buildPack: false };
  const subAssets: readonly { readonly guid: string }[] = runMeta.subAssets;
  for (const sub of subAssets) guidSeen.add(sub.guid.toLowerCase());
  const sourcePackage = await produceSourcePackage({
    meta: runMeta,
    registry: work.context.importerRegistry,
    fs: work.context.fsForImport,
  });
  if (!sourcePackage.ok) throw work.context.fail(sourcePackage.error);
  const ownerFinalizer = work.context.importerRegistry.get(runMeta.importer)?.finalize;
  if (ownerFinalizer !== undefined) {
    await emitFinalizedOwner(work, metaPath, subAssets, sourcePackage.value, ownerFinalizer);
    return;
  }
  const finalized = await finalizePackageTransportSource(
    projectImportProductForBuild(sourcePackage.value.product),
    {
      base: work.context.basePrefix,
      packagePath: `assets/${subAssets[0]?.guid ?? 'pack'}.pack.json`,
      artifactPath: (assetGuid, key) => `${assetGuid}-${key}.bin`,
      sink: () => {},
    },
  );
  const productByGuid = sourcePackageAssetsByGuid(sourcePackage.value);
  const runtimePublication = runtimePublicationFor(work.context, {
    pack: { assets: finalized.pack.assets },
    sourcePath: metaPath,
    sourceRevision: finalized.sourceRevision,
    packageUrl: finalized.packageUrl,
    digest: finalized.digest,
  });
  await emitPackDocument(work, {
    pack: runtimePublication.pack,
    artifacts: finalized.artifacts,
    packageName: `${subAssets[0]?.guid ?? 'pack'}.pack.json`,
    originalFileName: metaPath,
    guids: subAssets.map((sub) => sub.guid),
    projection: work.context.cookedCurrentProjection,
    refsByGuid: new Map(
      [...productByGuid].map(([guid, asset]) => [guid, asset.refs.map((ref) => ref.guid)]),
    ),
    publication: runtimePublication.publication,
  });
}

export async function produceBuildAssets(
  context: BuildProductionOptions,
): Promise<PackIndexEntry[]> {
  const entries = [...context.inventory.entries];
  const authored = await buildAuthoredPackages(context);
  const importedEntries = entries.map((entry) => {
    const scriptable = authored.get(entry.sourcePath);
    if (scriptable === undefined) return entry;
    const cookReceiptUrl = scriptable.receiptUrls.get(entry.guid.toLowerCase());
    return projectCookedPackageEntry(entry, {
      packageUrl: scriptable.packageUrl,
      revision: scriptable.revision,
      refs: scriptable.refs.get(entry.guid.toLowerCase()) ?? [],
      ...(cookReceiptUrl === undefined ? {} : { cookReceiptUrl }),
      publication: scriptable.publication,
    });
  });
  const guidSeen = new Set<string>();
  const work: BuildEmissionWork = { importedEntries, context };
  for (const entry of importedEntries) {
    if (!guidSeen.has(entry.guid.toLowerCase())) await emitBuildEntry(work, guidSeen, entry);
  }
  return importedEntries;
}

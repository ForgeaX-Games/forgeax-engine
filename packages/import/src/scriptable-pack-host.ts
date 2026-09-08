import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createAcceptedPublication } from '@forgeax/engine-ddc';
import {
  type AuthoredPackInput,
  finalizePackageTransportSource,
  loadAssetConfig,
  type PackageFinalizePolicy,
  resolveAssetSource,
  upgradeLegacyAuthoredPack,
} from '@forgeax/engine-pack/build';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type NativeCooker, NativeCookerRegistry } from '@forgeax/engine-pack/native-cooker';
import type { ScanSourceDeclaration } from '@forgeax/engine-pack/scanner';
import {
  projectScriptablePackSceneComponents,
  type ScriptablePackDefinition,
  type ScriptablePackSourceClosureEntry,
} from '@forgeax/engine-pack/source';
import { inventoryScriptablePackSource } from '@forgeax/engine-pack/source-node';
import type {
  Asset,
  AssetGuid as AssetGuidType,
  AssetPublicationEnvelope,
  AssetPublicationOutput,
  ResourceRevision,
  Result,
} from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import type { DdcPack, ImportRunnerFs, RunImportMeta } from './import-runner.js';
import type { ImporterRegistry } from './importer-registry.js';
import { projectImportProductForBuild } from './pack-projection.js';
import type { ScriptablePackDomainError, ScriptablePackStagedOutput } from './scriptable-pack.js';
import { createStandardAssetOutputProducerRegistry } from './scriptable-pack-output-producers.js';
import {
  createScriptablePackStagedAssetSnapshotSource,
  type ScriptablePackStagedOwner,
} from './scriptable-pack-staged-snapshot.js';
import {
  produceScriptableSourcePackage,
  type ScriptableSourcePackageProduct,
  type ScriptableSourcePackageResult,
} from './scriptable-source-package.js';
import { produceSourcePackage } from './source-package.js';

type FinalizedPackageTransport = Awaited<ReturnType<typeof finalizePackageTransportSource>>;

export interface ScriptablePackInput {
  readonly sourcePath: string;
  readonly displaySourcePath: string;
  readonly definition: Readonly<ScriptablePackDefinition>;
  readonly sourceClosure: readonly ScriptablePackSourceClosureEntry[];
  readonly publicationGeneration: number;
  readonly policy: ScriptablePackTransportPolicy;
}

export interface ScriptablePackPublicationFacts {
  readonly outputs: readonly AssetPublicationOutput[];
  readonly refs: ReadonlyMap<string, readonly string[]>;
}

export interface PreparedScriptablePack {
  readonly product: ScriptableSourcePackageProduct;
  readonly finalized: FinalizedPackageTransport;
  readonly facts: ScriptablePackPublicationFacts;
  readonly revision: ResourceRevision;
  readonly publication: AssetPublicationEnvelope;
}

export interface ScriptablePackTransportPaths {
  readonly packagePath: string;
  readonly artifactPath: (path: string) => string;
  readonly receiptPath: (guid: string) => string;
}

export interface ScriptablePackTransportSink {
  writePackage(path: string, body: string): void | Promise<void>;
  writeArtifact(path: string, bytes: Uint8Array, mimeType: string): void | Promise<void>;
  writeReceipt(path: string, body: string): void | Promise<void>;
}

export type ScriptablePackTransportPolicy =
  | PackageFinalizePolicy
  | ((product: ScriptableSourcePackageProduct) => PackageFinalizePolicy);

type ScriptablePackHostError =
  ScriptableSourcePackageResult extends Result<unknown, infer E> ? E : never;

export interface CookedAuthoredPack {
  readonly logicalPackage: DdcPack;
  readonly refsByGuid: ReadonlyMap<string, readonly string[]>;
}

export interface AuthoredPackTransport {
  readonly pack: AuthoredPackInput;
  readonly firstGuid?: string;
  readonly cooked?: CookedAuthoredPack;
  readonly finalized?: FinalizedPackageTransport;
}

/** Build-time capabilities required to expose ordinary Meta products to a ScriptablePack. */
export interface ScriptablePackExternalImportOptions {
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
  /** Package path aliases from forgeax.assets.paths; defaults to the current project config. */
  readonly assetPaths?: Readonly<Record<string, string>>;
}

export function canonicalScriptableSourcePath(sourcePath: string): string {
  const normalized = sourcePath.replaceAll('\\', '/');
  const marker = '/assets/';
  const markerIndex = normalized.indexOf(marker);
  return markerIndex < 0 ? normalized : normalized.slice(markerIndex + 1);
}

export function scriptablePackInputs(
  sourcePaths: readonly string[],
  declarations: ReadonlyMap<string, ScanSourceDeclaration>,
  cwd: string,
  generationFor: (displaySourcePath: string) => number,
  policyFor: (displaySourcePath: string) => ScriptablePackTransportPolicy,
): ScriptablePackInput[] {
  return sourcePaths.flatMap((sourcePath) => {
    const declaration = declarations.get(resolve(cwd, sourcePath));
    if (declaration?.format !== 'pack.ts') return [];
    const displaySourcePath = canonicalScriptableSourcePath(sourcePath);
    return [
      {
        sourcePath: resolve(cwd, sourcePath),
        displaySourcePath,
        definition: declaration.definition,
        sourceClosure: declaration.sourceClosure,
        publicationGeneration: generationFor(displaySourcePath),
        policy: policyFor(displaySourcePath),
      },
    ];
  });
}

/** Materialize one accepted ScriptablePack without duplicating dev/build loops. */
export async function materializePreparedScriptablePack(
  prepared: PreparedScriptablePack,
  paths: ScriptablePackTransportPaths,
  sink: ScriptablePackTransportSink,
): Promise<ReadonlyMap<string, string>> {
  const { product, finalized } = prepared;
  await sink.writePackage(paths.packagePath, JSON.stringify(finalized.pack));
  for (const artifact of finalized.artifacts) {
    await sink.writeArtifact(
      paths.artifactPath(artifact.path),
      artifact.bytes,
      artifact.path.endsWith('.json') ? 'application/json' : artifact.mediaType,
    );
  }
  const receipts = new Map<string, string>();
  for (const guid of product.declaredGuids) {
    const path = paths.receiptPath(guid);
    await sink.writeReceipt(
      path,
      JSON.stringify({
        guid,
        origin: 'sourceMeta',
        status: 'succeeded',
        inputFingerprint: product.inputFingerprint,
        outputDigest: finalized.digest,
      }),
    );
    receipts.set(guid, path);
  }
  return receipts;
}

export async function readCookedAuthoredPack(
  authoredPack: AuthoredPackInput,
  cookers: readonly NativeCooker[] = [],
  sourcePath?: string,
): Promise<CookedAuthoredPack | undefined> {
  const parsed = upgradeLegacyAuthoredPack(authoredPack);
  if (parsed.schemaVersion !== '2.0.0' || parsed.assets === undefined) return undefined;
  const registry = new NativeCookerRegistry();
  for (const cooker of cookers) registry.register(cooker);
  const assets: DdcPack['assets'][number][] = [];
  const refsByGuid = new Map<string, readonly string[]>();
  let hasCookedAsset = false;
  for (const asset of parsed.assets) {
    const shouldCook = asset.execution === 'cooked';
    if (!shouldCook) {
      assets.push({
        guid: asset.guid,
        kind: asset.kind,
        ...(asset.name === undefined ? {} : { name: asset.name }),
        ...(asset.sourceKey === undefined ? {} : { sourceKey: asset.sourceKey }),
        ...(asset.sourceIndex === undefined ? {} : { sourceIndex: asset.sourceIndex }),
        ...(asset.relations === undefined ? {} : { relations: asset.relations }),
        payload: asset.payload,
        refs: asset.refs ?? [],
        artifacts: {},
      });
      continue;
    }
    hasCookedAsset = true;
    const result = await registry.runDraft(asset.kind, {
      guid: asset.guid,
      source: asset.payload,
      ...(asset.sourceKey === undefined ? {} : { sourceKey: asset.sourceKey }),
      ...(sourcePath === undefined ? {} : { sourcePath }),
      refs: asset.refs ?? [],
    });
    if (!result.ok) throw result.error;
    const draft = result.value;
    const refs = [...draft.refs];
    refsByGuid.set(asset.guid.toLowerCase(), refs);
    assets.push({
      guid: draft.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      ...(asset.sourceKey === undefined ? {} : { sourceKey: asset.sourceKey }),
      ...(asset.sourceIndex === undefined ? {} : { sourceIndex: asset.sourceIndex }),
      ...(asset.relations === undefined ? {} : { relations: asset.relations }),
      payload: draft.payload as Record<string, unknown>,
      refs,
      artifacts: draft.artifacts,
    });
  }
  return hasCookedAsset
    ? {
        logicalPackage: { schemaVersion: '2.0.0', kind: 'internal-text-package', assets },
        refsByGuid,
      }
    : undefined;
}

export async function declaredPackExternalOutputs(
  declarations: ReadonlyMap<string, ScanSourceDeclaration>,
  cookers: readonly NativeCooker[] = [],
  requiredGuids: readonly AssetGuidType[] = [],
  externalImport?: ScriptablePackExternalImportOptions,
): Promise<readonly ScriptablePackStagedOutput[]> {
  if (requiredGuids.length === 0) return [];
  const required = new Set(requiredGuids.map((guid) => AssetGuid.format(guid).toLowerCase()));
  const outputs: ScriptablePackStagedOutput[] = [];
  for (const declaration of declarations.values()) {
    if (declaration.format === 'meta.json') {
      if (externalImport === undefined) continue;
      if (!declaration.value.subAssets.some((asset) => required.has(asset.guid.toLowerCase()))) {
        continue;
      }
      const assetPaths = externalImport.assetPaths ?? loadAssetConfig(process.cwd()).paths;
      const resolved = resolveAssetSource(
        declaration.sourcePath,
        declaration.value.source,
        assetPaths,
      );
      if (!resolved.ok) {
        throw new AssetError({
          code: 'asset-not-imported',
          expected: `a resolvable source for Meta dependency ${declaration.sourcePath}`,
          hint: 'repair the Meta source path before rebuilding the ScriptablePack',
        });
      }
      const meta: RunImportMeta = {
        importer: declaration.value.importer,
        source: resolved.value,
        sourceRevision: declaration.sourceRevision,
        ...(declaration.value.packageId === undefined
          ? {}
          : { packageId: declaration.value.packageId }),
        ...(declaration.value.provenance === undefined
          ? {}
          : { provenance: declaration.value.provenance }),
        ...(declaration.value.revision === undefined
          ? {}
          : { revision: declaration.value.revision }),
        ...(declaration.value.diagnostics === undefined
          ? {}
          : { diagnostics: declaration.value.diagnostics }),
        importSettings: declaration.value.importSettings,
        ...(declaration.value.sourceOverrides === undefined
          ? {}
          : { sourceOverrides: declaration.value.sourceOverrides }),
        subAssets: declaration.value.subAssets.map(({ guid, sourceIndex, sourceKey, kind }) => ({
          guid,
          sourceIndex,
          ...(sourceKey === undefined ? {} : { sourceKey }),
          kind,
        })),
        buildPack: false,
      };
      const sourcePackage = await produceSourcePackage({
        meta,
        registry: externalImport.importerRegistry,
        fs: externalImport.fsForImport,
      });
      if (!sourcePackage.ok) {
        throw new AssetError({
          code: 'asset-not-imported',
          expected: `the ${declaration.value.importer} importer to produce Meta dependency outputs`,
          hint: `repair ${declaration.sourcePath} before rebuilding the ScriptablePack`,
        });
      }
      for (const asset of sourcePackage.value.product.assets) {
        const key = asset.guid.toLowerCase();
        if (!required.has(key)) continue;
        const parsed = AssetGuid.parse(asset.guid);
        if (!parsed.ok) throw parsed.error;
        outputs.push({
          guid: parsed.value,
          asset: { kind: asset.kind, ...(asset.payload as Record<string, unknown>) } as Asset,
        });
      }
      continue;
    }
    if (declaration.format !== 'pack.json') continue;
    const declaredAssets = declaration.value.assets.filter((asset) =>
      required.has(asset.guid.toLowerCase()),
    );
    if (declaredAssets.length === 0) continue;
    const cooked = await readCookedAuthoredPack(declaration.value, cookers, declaration.sourcePath);
    for (const asset of cooked?.logicalPackage.assets.filter((item) =>
      required.has(item.guid.toLowerCase()),
    ) ?? declaredAssets) {
      const parsed = AssetGuid.parse(asset.guid);
      if (!parsed.ok) throw parsed.error;
      outputs.push({ guid: parsed.value, asset: { kind: asset.kind, ...asset.payload } as Asset });
    }
  }
  return outputs;
}

/** Normalize one authored Pack and, when needed, run its registered cooker once. */
export async function prepareAuthoredPackTransport(
  authoredPack: AuthoredPackInput,
  cookers: readonly NativeCooker[] | undefined,
  policyFor: (guid: string) => PackageFinalizePolicy,
  sourcePath?: string,
): Promise<AuthoredPackTransport> {
  const pack = upgradeLegacyAuthoredPack(authoredPack);
  const firstGuid = pack.assets?.[0]?.guid?.toLowerCase();
  if (pack.schemaVersion !== '2.0.0' || firstGuid === undefined) {
    return { pack, ...(firstGuid === undefined ? {} : { firstGuid }) };
  }
  const cooked = await readCookedAuthoredPack(pack, cookers, sourcePath);
  if (cooked === undefined) return { pack, firstGuid };
  return {
    pack,
    firstGuid,
    cooked,
    finalized: await finalizePackageTransportSource(cooked.logicalPackage, policyFor(firstGuid)),
  };
}

/** Project one produced ScriptablePack into the publication tuple shared by dev and build. */
export function projectScriptablePackPublication(
  product: ScriptableSourcePackageProduct,
): Result<ScriptablePackPublicationFacts, ScriptablePackDomainError> {
  const assets = new Map(product.product.assets.map((asset) => [asset.guid.toLowerCase(), asset]));
  const outputs: AssetPublicationOutput[] = [];
  for (const staged of product.stagedOutputs) {
    const guid = AssetGuid.format(staged.guid).toLowerCase();
    const asset = assets.get(guid);
    if (asset === undefined || staged.digest === undefined) {
      return err({
        code: 'pack-source-output-invalid',
        expected: `ScriptablePack publication output ${guid} to include a product and digest`,
        hint: 'repair the ScriptablePack producer output and rebuild',
        detail: { stage: 'publication', guid },
      });
    }
    outputs.push({
      guid,
      sourceKey: staged.sourceKey ?? guid,
      kind: asset.kind,
      digest: staged.digest,
      refs: asset.refs.map((reference) => reference.guid),
    });
  }
  return ok({
    outputs,
    refs: new Map(
      product.product.assets.map((asset) => [
        asset.guid.toLowerCase(),
        asset.refs.map((reference) => reference.guid),
      ]),
    ),
  });
}

/** Project the immutable module closure into the Catalog revision contract. */
async function scriptablePackResourceRevision(
  displaySourcePath: string,
  digest: string,
  sourceClosure: readonly ScriptablePackSourceClosureEntry[],
): Promise<ResourceRevision> {
  const observedAt = Math.trunc(
    Math.max(
      ...(await Promise.all(sourceClosure.map(async (entry) => (await stat(entry.path)).mtimeMs))),
    ),
  );
  return { digest, observedAt, rootId: displaySourcePath };
}

/** Produce selected ScriptablePacks through one inventory and one staged owner boundary. */
export async function produceScriptablePackProducts(
  sources: readonly ScriptablePackInput[],
  declaredExternalOutputs: readonly ScriptablePackStagedOutput[] = [],
): Promise<Result<ReadonlyMap<string, PreparedScriptablePack>, ScriptablePackHostError>> {
  const entries = new Map<
    string,
    {
      readonly source: ScriptablePackInput;
      readonly definition: Readonly<ScriptablePackDefinition>;
      readonly closure: readonly ScriptablePackSourceClosureEntry[];
    }
  >();
  for (const source of sources) {
    if (entries.has(source.displaySourcePath)) continue;
    entries.set(source.displaySourcePath, {
      source,
      definition: source.definition,
      closure: source.sourceClosure,
    });
  }

  const products = new Map<string, ScriptableSourcePackageProduct>();
  const owners: ScriptablePackStagedOwner[] = [...entries.entries()].map(
    ([displaySourcePath, entry]) => ({
      id: displaySourcePath,
      guids: Object.values(entry.definition.assets).map((asset) => asset.guid),
      async build(source) {
        const produced = await produceScriptableSourcePackage({
          definition: entry.definition,
          sourcePath: displaySourcePath,
          assetSource: source,
          outputs: createStandardAssetOutputProducerRegistry(
            projectScriptablePackSceneComponents(entry.definition.sceneComponents),
          ),
          sourceClosure: entry.closure,
          authoringContractVersion: 'scriptable-pack-production/1',
        });
        if (!produced.ok) return produced;
        const observedClosure = await inventoryScriptablePackSource(entry.source.sourcePath);
        if (JSON.stringify(observedClosure) !== JSON.stringify(entry.closure)) {
          return err({
            code: 'pack-source-load-failed',
            expected: 'the complete ScriptablePack module closure to remain fixed during one build',
            hint: 'retry the build after source and helper writes have settled',
            detail: {
              sourcePath: displaySourcePath,
              reason: 'source-changed',
              phase: 'build',
              diagnostic: 'module closure changed while the staged generation was building',
            },
          });
        }
        products.set(displaySourcePath, produced.value);
        return ok(produced.value.stagedOutputs);
      },
    }),
  );
  const generationDigest = createHash('sha256')
    .update(
      JSON.stringify(
        [...entries.values()]
          .flatMap((entry) => entry.closure)
          .sort((a, b) => a.path.localeCompare(b.path)),
      ),
    )
    .digest();
  const stagedSource = createScriptablePackStagedAssetSnapshotSource({
    generation: generationDigest.readUInt32BE(0),
    owners,
    declaredExternalOutputs,
  });

  const prepared = new Map<string, PreparedScriptablePack>();
  for (const source of sources) {
    const entry = entries.get(source.displaySourcePath);
    if (entry === undefined) {
      return err({
        code: 'pack-source-path-invalid',
        expected: 'a ScriptablePack source registered in the current inventory',
        actual: source.displaySourcePath,
        hint: 'rebuild the source inventory before producing this path',
        retryable: true,
        recoveryActions: ['rebuild-source-inventory'],
        detail: { sourcePath: source.displaySourcePath },
      });
    }
    const first = Object.values(entry.definition.assets)[0];
    if (first === undefined) {
      return err({
        code: 'pack-source-output-invalid',
        expected: 'at least one declared ScriptablePack output',
        hint: 'add an output descriptor before building the package',
        detail: { missingGuids: [], unexpectedSourceKeys: [], kindMismatches: [] },
      });
    }
    const staged = await stagedSource.readByGuid(first.guid);
    if (!staged.ok) return err(staged.error);
    const produced = products.get(source.displaySourcePath);
    if (produced === undefined) {
      return err({
        code: 'pack-source-output-invalid',
        expected: 'the staged owner build to retain its source-package product',
        hint: 'retry the ScriptablePack production attempt',
        detail: {
          missingGuids: [AssetGuid.format(first.guid)],
          unexpectedSourceKeys: [],
          kindMismatches: [],
        },
      });
    }
    const transportPolicy =
      typeof source.policy === 'function' ? source.policy(produced) : source.policy;
    const logicalPackage = projectImportProductForBuild(produced.product);
    const finalized = await finalizePackageTransportSource(logicalPackage, transportPolicy);
    const facts = projectScriptablePackPublication(produced);
    if (!facts.ok) return err(facts.error);
    const revision = await scriptablePackResourceRevision(
      source.displaySourcePath,
      produced.inputFingerprint,
      source.sourceClosure,
    );
    const publication = createAcceptedPublication({
      sourcePath: source.displaySourcePath,
      sourceRevision: produced.inputFingerprint,
      generation: source.publicationGeneration,
      digest: finalized.digest,
      packageUrl: finalized.packageUrl,
      inputFingerprint: produced.inputFingerprint,
      outputs: facts.value.outputs,
      externalEvidence: produced.externalEvidence,
    });
    prepared.set(source.displaySourcePath, {
      product: produced,
      finalized,
      facts: facts.value,
      revision,
      publication,
    });
  }
  return ok(prepared);
}

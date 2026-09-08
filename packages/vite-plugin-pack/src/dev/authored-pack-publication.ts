import { resolve } from 'node:path';
import type {
  AcceptedPublicationStore,
  ScriptablePackPublicationSnapshot,
} from '@forgeax/engine-ddc';
import type { ImporterRegistry, ImportRunnerFs } from '@forgeax/engine-import';
import {
  canonicalScriptableSourcePath,
  declaredPackExternalOutputs,
  materializePreparedScriptablePack,
  prepareAuthoredPackTransport,
  produceScriptablePackProducts,
  projectImportProductForBuild,
  scriptablePackInputs,
} from '@forgeax/engine-import';
import {
  createRuntimePackPublication,
  loadAssetConfig,
  packageTransportRevision,
} from '@forgeax/engine-pack/build';
import type { ScanSourceDeclaration } from '@forgeax/engine-pack/scanner';
import type {
  AssetPublicationEnvelope,
  PackIndexEntry,
  ResourceRevision,
} from '@forgeax/engine-types';
import type { PluginPackInternalOptions } from '../plugin-contract.js';
import { structuredPluginError } from '../structured-plugin-error.js';

export type { AuthoredPackInput } from '@forgeax/engine-pack/build';

export interface AuthoredPackPublicationContext {
  readonly opts: PluginPackInternalOptions;
  readonly transportBase?: string | undefined;
  readonly metaPackBodies: Map<string, string>;
  readonly devArtifactBodies: Map<
    string,
    { readonly bytes: Uint8Array; readonly mimeType: string }
  >;
  readonly publicationCandidates: Map<string, AssetPublicationEnvelope>;
  readonly importedGuids: Set<string>;
  readonly publicationStore: AcceptedPublicationStore;
  readonly scopeId?: string;
  readonly signal?: AbortSignal;
  readonly sourceDeclarations: ReadonlyMap<string, ScanSourceDeclaration>;
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
  readonly currentProjection: Record<string, unknown>;
  readonly directProjection: Record<string, unknown>;
  readonly authoredCookedProjection: Record<string, unknown>;
}

const DEV_PACK_PREFIX = '/__forgeax-ddc/';

/**
 * Keep a deterministic republish on the accepted generation.
 *
 * The production session generation is an attempt fence, while the
 * publication generation is the durable identity carried by authored scene
 * mounts. Watcher noise can schedule several attempts for the same source
 * bytes; minting a new publication generation for each one makes an
 * unchanged saved mount fail its own publication fence. Reuse the accepted
 * generation only when the complete source/output tuple is unchanged.
 */
export function preserveAcceptedPublicationGeneration(
  publication: AssetPublicationEnvelope,
  snapshot: ScriptablePackPublicationSnapshot,
): AssetPublicationEnvelope {
  const accepted = snapshot.current;
  if (
    accepted === undefined ||
    accepted.sourcePath !== publication.sourcePath ||
    accepted.sourceRevision !== publication.sourceRevision ||
    accepted.digest !== publication.digest ||
    accepted.outputSetDigest !== publication.outputSetDigest ||
    accepted.generation === publication.generation
  ) {
    return publication;
  }
  return {
    ...publication,
    generation: accepted.generation,
    ...(publication.current === undefined
      ? {}
      : { current: { ...publication.current, generation: accepted.generation } }),
  };
}

function assertPublicationOpen(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  throw structuredPluginError({
    code: 'cleanup-failed',
    expected: 'the active production generation to remain open while publishing authored Packs',
    hint: 'discard the aborted candidate and retry the next generation',
    detail: { stage: 'cleanup', subject: 'authored-pack-publication' },
  });
}

export async function publishAuthoredDevPacks(
  raw: readonly PackIndexEntry[],
  context: AuthoredPackPublicationContext,
): Promise<PackIndexEntry[]> {
  assertPublicationOpen(context.signal);
  const published = new Map<string, string>();
  const stagedPackBodies = new Map<string, string>();
  const stagedArtifactBodies = new Map<
    string,
    { readonly bytes: Uint8Array; readonly mimeType: string }
  >();
  const cookedRefs = new Map<string, ReadonlyMap<string, readonly string[]>>();
  const scriptableReceipts = new Map<string, ReadonlyMap<string, string>>();
  const scriptableRevisions = new Map<string, ResourceRevision>();
  const scriptablePublications = new Map<string, AssetPublicationEnvelope>();
  const authoredPublications = new Map<string, AssetPublicationEnvelope>();
  // The requested rows may contain only one consumer, but the generation must
  // retain every local ScriptablePack owner so content reads never fall back to
  // an older Pack generation.
  const scriptableSources = [...context.sourceDeclarations.entries()]
    .filter(([, declaration]) => declaration.format === 'pack.ts')
    .map(([sourcePath]) => sourcePath);
  const inputs = scriptablePackInputs(
    scriptableSources,
    context.sourceDeclarations,
    process.cwd(),
    (displaySourcePath) =>
      (context.publicationStore.observe(displaySourcePath).current?.generation ?? 0) + 1,
    () => (product) => {
      const transportRevision = `${product.inputFingerprint}:${packageTransportRevision(
        projectImportProductForBuild(product.product),
      )}`.replace(/[^a-zA-Z0-9._-]/g, '-');
      return {
        base: '/',
        packagePath:
          `${DEV_PACK_PREFIX}${product.anchorGuid}.${transportRevision}.pack.json`.replace(
            /^\/+/,
            '',
          ),
        artifactPath: (guid, key) =>
          `${guid.toLowerCase()}/${transportRevision}/${key.includes('.') ? key : `${key}.bin`}`,
      };
    },
  );
  const preparedScriptablePacks = await produceScriptablePackProducts(
    inputs,
    await declaredPackExternalOutputs(
      context.sourceDeclarations,
      context.opts.cookers ?? [],
      inputs.flatMap((input) => Object.values(input.definition.externalAssets)),
      {
        importerRegistry: context.importerRegistry,
        fsForImport: context.fsForImport,
        assetPaths: loadAssetConfig(process.cwd()).paths,
      },
    ),
  );
  if (!preparedScriptablePacks.ok) throw structuredPluginError(preparedScriptablePacks.error);
  for (const entry of raw) {
    assertPublicationOpen(context.signal);
    if (!entry.sourcePath.endsWith('.pack.ts') || published.has(entry.sourcePath)) continue;
    const canonicalSourcePath = canonicalScriptableSourcePath(entry.sourcePath);
    const prepared = preparedScriptablePacks.value.get(canonicalSourcePath);
    if (prepared === undefined) {
      throw structuredPluginError({
        code: 'catalog-declaration-missing',
        expected: 'the ScriptablePack inventory to retain every authored Pack source',
        hint: 'rerun the source inventory and publish only the accepted declaration set',
        detail: { stage: 'scan', sourcePath: entry.sourcePath },
      });
    }
    const { product, finalized, facts, revision } = prepared;
    const publication = preserveAcceptedPublicationGeneration(
      prepared.publication,
      context.publicationStore.observe(canonicalSourcePath),
    );
    const packageUrl = finalized.packageUrl;
    const transportRevision = `${product.inputFingerprint}:${packageTransportRevision(
      projectImportProductForBuild(product.product),
    )}`.replace(/[^a-zA-Z0-9._-]/g, '-');
    assertPublicationOpen(context.signal);
    const receiptUrls = await materializePreparedScriptablePack(
      prepared,
      {
        packagePath: packageUrl,
        artifactPath: (path) => `${DEV_PACK_PREFIX}${path}`,
        receiptPath: (guid) => `${DEV_PACK_PREFIX}${guid}.${transportRevision}.receipt.json`,
      },
      {
        writePackage: (path, body) => {
          stagedPackBodies.set(path, body);
        },
        writeArtifact: (path, bytes, mimeType) => {
          stagedArtifactBodies.set(path, { bytes, mimeType });
        },
        writeReceipt: (path, body) => {
          stagedArtifactBodies.set(path, {
            bytes: new TextEncoder().encode(body),
            mimeType: 'application/json',
          });
        },
      },
    );
    const runtimePublication = createRuntimePackPublication({
      pack: { assets: finalized.pack.assets },
      scopeId: context.scopeId ?? 'asset-runtime',
      sourcePath: publication.sourcePath,
      sourceRevision: publication.sourceRevision,
      packageUrl,
      inputFingerprint: publication.receipt.inputFingerprint,
      digest: finalized.digest,
      generation: publication.generation,
      outputs: facts.outputs,
      externalEvidence: publication.externalEvidence,
    });
    stagedPackBodies.set(packageUrl, JSON.stringify(runtimePublication.pack));
    published.set(entry.sourcePath, packageUrl);
    scriptableReceipts.set(entry.sourcePath, receiptUrls);
    scriptableRevisions.set(entry.sourcePath, revision);
    cookedRefs.set(entry.sourcePath, facts.refs);
    const accepted = context.publicationStore.stage(canonicalSourcePath, { envelope: publication });
    assertPublicationOpen(context.signal);
    if (!accepted.ok) {
      throw structuredPluginError({
        code: accepted.error.code,
        expected: 'DDC to accept the ScriptablePack publication tuple',
        hint: accepted.error.reason,
        detail: { stage: accepted.error.stage, sourcePath: canonicalSourcePath },
      });
    }
    context.publicationCandidates.set(canonicalSourcePath, publication);
    scriptablePublications.set(entry.sourcePath, runtimePublication.publication);
  }
  for (const entry of raw) {
    assertPublicationOpen(context.signal);
    if (
      !entry.packageUrl.endsWith('.pack.json') ||
      entry.packageUrl.includes(DEV_PACK_PREFIX) ||
      published.has(entry.packageUrl)
    ) {
      continue;
    }
    const sourcePath = resolve(process.cwd(), entry.sourcePath);
    const declaration = context.sourceDeclarations.get(sourcePath);
    if (declaration?.format !== 'pack.json') {
      throw structuredPluginError({
        code: 'catalog-declaration-missing',
        expected: 'the scanner inventory to contain the authored Pack declaration',
        hint: 'rerun Pack inventory and publish only the accepted declaration set',
        detail: { stage: 'scan', sourcePath },
      });
    }
    const prepared = await prepareAuthoredPackTransport(
      declaration.value,
      context.opts.cookers,
      (guid) => ({
        base: '/',
        packagePath: `${DEV_PACK_PREFIX}${guid}.pack.json`.replace(/^\/+/, ''),
        artifactPath: (artifactGuid, key) => `${artifactGuid}/${key}.bin`,
      }),
      sourcePath,
    );
    const firstGuid = prepared.firstGuid;
    if (firstGuid === undefined) continue;
    assertPublicationOpen(context.signal);
    const packageUrl = `${DEV_PACK_PREFIX}${firstGuid}.pack.json`;
    published.set(entry.packageUrl, packageUrl);
    const finalized = prepared.finalized;
    const authoredPack = finalized?.pack ?? prepared.pack;
    if (authoredPack.assets === undefined) continue;
    const runtimePublication = createRuntimePackPublication({
      pack: { assets: authoredPack.assets },
      scopeId: context.scopeId ?? 'asset-runtime',
      sourcePath,
      sourceRevision: declaration.sourceRevision,
      packageUrl: finalized?.packageUrl ?? packageUrl,
      ...(finalized === undefined ? {} : { digest: finalized.digest }),
    });
    authoredPublications.set(entry.packageUrl, runtimePublication.publication);
    stagedPackBodies.set(packageUrl, JSON.stringify(runtimePublication.pack));
    if (finalized === undefined) continue;
    assertPublicationOpen(context.signal);
    for (const artifact of finalized.artifacts) {
      stagedArtifactBodies.set(`${DEV_PACK_PREFIX}${artifact.path}`, {
        bytes: artifact.bytes,
        mimeType: artifact.mediaType,
      });
    }
    published.set(entry.packageUrl, finalized.packageUrl);
    cookedRefs.set(entry.packageUrl, prepared.cooked?.refsByGuid ?? new Map());
  }
  const projected = raw.map((entry) => {
    if (entry.sourcePath.endsWith('.pack.ts')) {
      const packageUrl = published.get(entry.sourcePath);
      if (packageUrl === undefined) return entry;
      const receiptUrl = scriptableReceipts.get(entry.sourcePath)?.get(entry.guid.toLowerCase());
      const revision = scriptableRevisions.get(entry.sourcePath);
      const publication = scriptablePublications.get(entry.sourcePath);
      if (revision === undefined || publication === undefined) return entry;
      return {
        ...entry,
        packageUrl,
        ...(receiptUrl === undefined ? {} : { cookReceiptUrl: receiptUrl }),
        revision,
        publication,
        ...context.currentProjection,
        refs: cookedRefs.get(entry.sourcePath)?.get(entry.guid.toLowerCase()) ?? [],
      };
    }
    const packageUrl = published.get(entry.packageUrl);
    if (packageUrl === undefined) return entry;
    const refs = cookedRefs.get(entry.packageUrl)?.get(entry.guid.toLowerCase());
    if (refs !== undefined) {
      const publication = authoredPublications.get(entry.packageUrl);
      return {
        ...entry,
        packageUrl,
        ...context.authoredCookedProjection,
        ...(publication === undefined ? {} : { publication }),
        refs,
      };
    }
    const publication = authoredPublications.get(entry.packageUrl);
    return publication === undefined
      ? { ...entry, packageUrl, ...context.directProjection }
      : { ...entry, packageUrl, publication, ...context.directProjection };
  });
  for (const [url, body] of stagedPackBodies) context.metaPackBodies.set(url, body);
  assertPublicationOpen(context.signal);
  for (const [url, body] of stagedArtifactBodies) context.devArtifactBodies.set(url, body);
  for (const entry of projected) {
    if (entry.packageUrl.startsWith(DEV_PACK_PREFIX)) {
      context.importedGuids.add(entry.guid.toLowerCase());
    }
  }
  return projected;
}

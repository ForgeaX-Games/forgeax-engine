import { semanticBuildKey } from '@forgeax/engine-ddc';
import {
  finalizeSourcePackage,
  IMPORT_ERROR_HINTS,
  ImportError,
  type ImporterRegistry,
  type ImportPublicationInput,
  type ImportRunnerFs,
  projectImportProductForBuild,
  publishImportPublication,
  type RunImportMeta,
  runImport,
  type StagedImportPublication,
  stageImportPublication,
} from '@forgeax/engine-import';
import {
  type CatalogBuildResult,
  calculateCatalogDelta,
  createRuntimePackPublication,
  finalizePackageTransportSource,
} from '@forgeax/engine-pack/build';
import type { PackIndexEntry, RuntimeAssetBinding } from '@forgeax/engine-types';

export interface MetaImportContext {
  readonly ddcRoot: (cwd: string, binding?: RuntimeAssetBinding) => string;
  readonly runtimeBinding?: RuntimeAssetBinding;
  readonly getCatalogProjection: () => CatalogBuildResult;
  readonly setCatalogProjection: (projection: CatalogBuildResult) => void;
  readonly importedGuids: Set<string>;
  readonly metaPackBodies: Map<string, string>;
  readonly devArtifactBodies: Map<
    string,
    { readonly bytes: Uint8Array; readonly mimeType: string }
  >;
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
  readonly publishCatalogDelta:
    | ((delta: import('@forgeax/engine-types').CatalogDelta) => void)
    | undefined;
  readonly cookedProjection: Record<string, unknown>;
  readonly pendingImportPublications?: Map<string, StagedImportPublication>;
  /** Validated by the Pack inventory; absent only for on-demand route misses. */
  readonly declaration?: RunImportMeta;
  readonly signal?: AbortSignal;
}

const DEV_PACK_PREFIX = '/__forgeax-ddc/';

function assertImportOpen(context: MetaImportContext, metaPath: string): void {
  if (!context.signal?.aborted) return;
  throw new ImportError({
    code: 'import-internal-error',
    expected: `the import for ${metaPath} to finish before the dev session closes`,
    hint: 'discard the aborted import and retry after the next generation is serving',
    detail: { reason: 'dev session aborted' },
  });
}

export async function startMetaImport(
  metaPath: string,
  context: MetaImportContext,
): Promise<PackIndexEntry[]> {
  assertImportOpen(context, metaPath);
  const previousCatalog = [...context.getCatalogProjection().entries];
  const catalog = [...previousCatalog];
  const previousImportedGuids = new Set(context.importedGuids);
  const meta = context.declaration;
  if (meta === undefined) {
    throw new ImportError({
      code: 'import-internal-error',
      expected: `a validated import declaration for ${metaPath}`,
      hint: IMPORT_ERROR_HINTS['import-internal-error'],
      detail: { reason: `missing import declaration: ${metaPath}` },
    });
  }
  const runResult = await runImport(meta, context.importerRegistry, context.fsForImport);
  assertImportOpen(context, metaPath);
  if (!runResult.ok) throw runResult.error;
  if ('skipped' in runResult.value) return [];

  const routeSubGuid = meta.subAssets[0]?.guid?.toLowerCase();
  const finalizedProduct = finalizeSourcePackage(
    runResult.value.product,
    routeSubGuid === undefined ? undefined : context.importerRegistry.get(meta.importer)?.finalize,
    (artifact) =>
      `${DEV_PACK_PREFIX}${routeSubGuid ?? meta.subAssets[0]?.guid ?? 'pack'}/${artifact.path}`,
  );
  if (!finalizedProduct.ok) {
    throw new ImportError({
      code: 'import-internal-error',
      expected: finalizedProduct.error.expected,
      hint: finalizedProduct.error.hint,
      detail: {
        reason:
          finalizedProduct.error.detail !== null &&
          typeof finalizedProduct.error.detail === 'object' &&
          'token' in finalizedProduct.error.detail &&
          typeof finalizedProduct.error.detail.token === 'string'
            ? finalizedProduct.error.detail.token
            : finalizedProduct.error.code,
      },
    });
  }
  const transportProduct = finalizedProduct.value;
  const logicalPackage = projectImportProductForBuild(transportProduct);
  const finalizedRoute =
    routeSubGuid === undefined
      ? undefined
      : await finalizePackageTransportSource(logicalPackage, {
          base: '/',
          packagePath: `${DEV_PACK_PREFIX.replace(/^\/+/, '')}${routeSubGuid}.pack.json`,
          artifactPath: (guid, key) => `${guid}/${key}.bin`,
          sink: (path, bytes) => {
            if (context.signal?.aborted) return;
            const cleanPath = path.replace(/^\/+/, '');
            if (cleanPath.endsWith('.pack.json')) {
              context.metaPackBodies.set(`/${cleanPath}`, new TextDecoder().decode(bytes));
              return;
            }
            context.devArtifactBodies.set(`${DEV_PACK_PREFIX}${cleanPath}`, {
              bytes,
              mimeType: 'application/octet-stream',
            });
          },
        });
  assertImportOpen(context, metaPath);

  const firstSubGuid = meta.subAssets[0]?.guid?.toLowerCase();
  const packUrl =
    firstSubGuid === undefined ? undefined : `${DEV_PACK_PREFIX}${firstSubGuid}.pack.json`;
  const cookedDigest = runResult.value.cookProducts
    .map((product) => `${product.guid.toLowerCase()}=${product.digest}`)
    .sort()
    .join('|');
  const desiredKey =
    firstSubGuid === undefined
      ? undefined
      : semanticBuildKey({
          schemaVersion: '2.0.0',
          importerVersion: meta.importer,
          codecVersion: 'pack-v2',
          sourceDependencies: [{ path: meta.source, digest: cookedDigest }],
          settings: meta.importSettings ?? {},
          declaredGuids: meta.subAssets.map((sub) => sub.guid),
          cookProfile: 'dev',
          ...(meta.sourceOverrides === undefined ? {} : { sourceOverrides: meta.sourceOverrides }),
        });
  const outputByGuid = new Map(
    runResult.value.cookProducts.map((product) => [product.guid.toLowerCase(), product]),
  );
  const publicationOutputs = transportProduct.assets.map((asset) => {
    const product = outputByGuid.get(asset.guid.toLowerCase());
    if (product === undefined) {
      throw new ImportError({
        code: 'import-internal-error',
        expected: `the importer to retain CookProduct evidence for ${asset.guid}`,
        hint: 'preserve the complete producer output set before publishing the runtime tuple',
        detail: { reason: `missing CookProduct: ${asset.guid}` },
      });
    }
    return {
      guid: asset.guid,
      sourceKey:
        meta.subAssets.find((sub) => sub.guid.toLowerCase() === asset.guid.toLowerCase())
          ?.sourceKey ?? asset.guid,
      kind: asset.kind,
      digest: product.digest,
      refs: asset.refs.map((ref) => ref.guid),
    };
  });
  const runtimePublication =
    firstSubGuid === undefined || packUrl === undefined || desiredKey === undefined
      ? undefined
      : createRuntimePackPublication({
          pack: finalizedRoute?.pack ?? projectImportProductForBuild(transportProduct),
          scopeId: context.runtimeBinding?.scopeId ?? 'asset-runtime',
          sourcePath: metaPath,
          sourceRevision: runResult.value.product.sourceRevision,
          packageUrl: packUrl,
          inputFingerprint: desiredKey,
          ...(finalizedRoute === undefined ? {} : { digest: finalizedRoute.digest }),
          outputs: publicationOutputs,
        });
  const pack =
    runtimePublication?.pack ??
    finalizedRoute?.pack ??
    projectImportProductForBuild(transportProduct);
  const allEntries: PackIndexEntry[] = [];
  const previousPackBody = packUrl === undefined ? undefined : context.metaPackBodies.get(packUrl);
  if (packUrl !== undefined) context.metaPackBodies.set(packUrl, JSON.stringify(pack));

  const productByGuid = new Map(
    transportProduct.assets.map((asset) => [asset.guid.toLowerCase(), asset]),
  );
  for (const sub of meta.subAssets) {
    assertImportOpen(context, metaPath);
    const guidLower = sub.guid.toLowerCase();
    const raw = catalog.find((entry) => entry.guid.toLowerCase() === guidLower);
    if (raw === undefined) continue;
    const { sourceOverrides: _staleSourceOverrides, ...currentRaw } = raw;
    const currentSourceOverrides =
      meta.sourceOverrides === undefined
        ? {}
        : {
            sourceOverrides: meta.sourceOverrides as NonNullable<PackIndexEntry['sourceOverrides']>,
          };
    const importedAsset = productByGuid.get(guidLower);
    const importedRow: PackIndexEntry = {
      ...currentRaw,
      ...currentSourceOverrides,
      ...(packUrl === undefined ? {} : { packageUrl: packUrl, ...context.cookedProjection }),
      ...(runtimePublication === undefined ? {} : { publication: runtimePublication.publication }),
      ...(importedAsset?.refs === undefined
        ? {}
        : { refs: importedAsset.refs.map((ref) => ref.guid) }),
    };
    const index = catalog.findIndex((entry) => entry.guid.toLowerCase() === guidLower);
    if (index >= 0) catalog[index] = importedRow;
    allEntries.push(importedRow);
  }
  context.setCatalogProjection({ ...context.getCatalogProjection(), entries: catalog });

  if (runtimePublication !== undefined && firstSubGuid !== undefined && desiredKey !== undefined) {
    const publicationInput: ImportPublicationInput = {
      root: context.ddcRoot(process.cwd(), context.runtimeBinding),
      guid: firstSubGuid,
      desiredKey,
      pack,
      previousCatalog,
      nextCatalog: catalog,
      publishedGuids: allEntries.map((entry) => entry.guid),
      transport: {
        path: `${context.ddcRoot(process.cwd(), context.runtimeBinding)}/${firstSubGuid}.pack.json`,
        body: JSON.stringify(pack),
      },
    };
    const staged =
      context.pendingImportPublications === undefined
        ? undefined
        : await stageImportPublication(publicationInput);
    const publication =
      staged === undefined
        ? await publishImportPublication(publicationInput)
        : staged.ok
          ? {
              ok: true as const,
              key: staged.candidate.key,
              head: staged.candidate.head,
              catalog: staged.candidate.catalog,
              revision: staged.candidate.revision,
              transportPersisted: true,
            }
          : staged;
    if (staged?.ok === true) {
      context.pendingImportPublications?.set(
        `${metaPath}\0${staged.candidate.key}`,
        staged.candidate,
      );
    }
    assertImportOpen(context, metaPath);
    if (!publication.ok) {
      context.setCatalogProjection({ ...context.getCatalogProjection(), entries: previousCatalog });
      context.importedGuids.clear();
      for (const guid of previousImportedGuids) context.importedGuids.add(guid);
      if (packUrl !== undefined) {
        if (previousPackBody === undefined) context.metaPackBodies.delete(packUrl);
        else context.metaPackBodies.set(packUrl, previousPackBody);
      }
      const previousRows = previousCatalog.filter((entry) =>
        allEntries.some((candidate) => candidate.guid.toLowerCase() === entry.guid.toLowerCase()),
      );
      if (previousRows.length > 0) return previousRows;
      throw new ImportError({
        code: 'import-internal-error',
        expected: publication.error.expected,
        hint: publication.error.hint,
        detail: { reason: publication.error.detail },
      });
    }
    const delta = calculateCatalogDelta(previousCatalog, publication.catalog);
    // A production generation publishes its accepted candidate through the
    // outer watcher after every owner commits. Direct route imports have no
    // candidate owner, so they remain responsible for publishing their delta.
    if (delta !== undefined && context.pendingImportPublications === undefined) {
      context.publishCatalogDelta?.(delta);
    }
    context.setCatalogProjection({
      ...context.getCatalogProjection(),
      entries: [...publication.catalog],
    });
    const publishedRows = new Map(
      publication.catalog.map((entry) => [entry.guid.toLowerCase(), entry]),
    );
    for (let index = 0; index < allEntries.length; index += 1) {
      const current = allEntries[index];
      const projected =
        current === undefined ? undefined : publishedRows.get(current.guid.toLowerCase());
      if (projected !== undefined) allEntries[index] = projected;
    }
    if (publication.transportPersisted !== false) {
      for (const entry of allEntries) context.importedGuids.add(entry.guid.toLowerCase());
    } else {
      console.warn('[forgeax-pack] persist DDC pack failed:', {
        code: 'source-package-ddc-persistence-failed',
        guid: firstSubGuid,
        packageUrl: packUrl,
      });
    }
  }
  return allEntries;
}

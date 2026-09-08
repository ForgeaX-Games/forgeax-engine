import type { BuildProductionSink, ImporterRegistry, ImportRunnerFs } from '@forgeax/engine-import';
import { buildCatalogResult, produceBuildAssets } from '@forgeax/engine-import';
import {
  type CatalogProducerVisibility,
  STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
} from '@forgeax/engine-pack/build';
import { type PackIndexEntry, validateCatalogDelta } from '@forgeax/engine-types';
import { assertBuildRoots, projectPackIndexUrl, resolvePackBuildInputs } from '../build-inputs.js';
import { structuredPluginError } from '../structured-plugin-error.js';

export type MinimalPluginContext = Pick<BuildProductionSink, 'emitFile' | 'getFileName'>;

export interface PluginBuildContext {
  readonly opts: import('../plugin-contract.js').PluginPackInternalOptions;
  readonly transportBase?: string | undefined;
  readonly registeredImporterKeys: ReadonlySet<string>;
  readonly catalogVisibility: CatalogProducerVisibility;
  readonly importerRegistry: ImporterRegistry;
  readonly fsForImport: ImportRunnerFs;
  readonly cookedCurrentProjection: Record<string, unknown>;
  readonly directCurrentProjection: Record<string, unknown>;
  readonly authoredCookedCurrentProjection: Record<string, unknown>;
}

async function buildProduction(
  plugin: MinimalPluginContext,
  roots: readonly string[],
  context: PluginBuildContext,
): Promise<void> {
  const scanOptions = {
    scriptablePack: STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
    ...(context.opts.ignorePath === undefined ? {} : { ignorePath: context.opts.ignorePath }),
  };
  const inventory = await buildCatalogResult(
    roots,
    context.transportBase,
    context.registeredImporterKeys,
    scanOptions,
    context.catalogVisibility,
  );
  if (inventory.authority !== 'authoritative') {
    throw structuredPluginError({
      code: 'catalog-degraded',
      expected: 'one authoritative Catalog inventory before build emission',
      hint: 'repair the source roots and rerun the build',
      detail: { authority: inventory.authority, diagnostics: inventory.diagnostics },
    });
  }
  const { basePrefix } = resolvePackBuildInputs({
    roots: context.opts.roots,
    base: context.transportBase,
  });
  const productionCatalog: PackIndexEntry[] = await produceBuildAssets({
    inventory,
    cwd: process.cwd(),
    basePrefix,
    generation: 1,
    cookers: context.opts.cookers ?? [],
    importerRegistry: context.importerRegistry,
    fsForImport: context.fsForImport,
    cookedCurrentProjection: context.cookedCurrentProjection,
    directCurrentProjection: context.directCurrentProjection,
    authoredCookedCurrentProjection: context.authoredCookedCurrentProjection,
    ...(context.opts.runtimeBinding === undefined
      ? {}
      : { runtimeBinding: context.opts.runtimeBinding }),
    sink: {
      emitFile: (asset) => plugin.emitFile(asset),
      getFileName: (referenceId) => plugin.getFileName(referenceId),
      fileUrl: (fileName) => projectPackIndexUrl(basePrefix, fileName),
    },
    fail: structuredPluginError,
  });
  const catalogValidation = validateCatalogDelta({
    added: productionCatalog,
    changed: [],
    removed: [],
  });
  if (!catalogValidation.ok) throw structuredPluginError(catalogValidation.error);
  plugin.emitFile({
    type: 'asset',
    fileName: 'pack-index.json',
    source: JSON.stringify(productionCatalog),
  });
}

export function createPluginBuild(context: PluginBuildContext) {
  let buildTask: Promise<void> | undefined;

  async function generateBundle(this: MinimalPluginContext): Promise<void> {
    const { roots } = resolvePackBuildInputs({
      roots: context.opts.roots,
      base: context.transportBase,
    });
    await assertBuildRoots(roots);
    if (buildTask === undefined) {
      buildTask = buildProduction(this, roots, context);
    }
    await buildTask;
  }

  return {
    generateBundle,
    async closeBundle(): Promise<void> {
      buildTask = undefined;
    },
  };
}

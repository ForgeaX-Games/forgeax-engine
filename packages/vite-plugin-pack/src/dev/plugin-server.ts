import { resolve } from 'node:path';
import type { RunImportMeta, StagedImportPublication } from '@forgeax/engine-import';
import type { CatalogBuildResult, CatalogProducerVisibility } from '@forgeax/engine-pack/build';
import type { ScanSourceDeclaration } from '@forgeax/engine-pack/scanner';
import type {
  AssetPublicationEnvelope,
  CatalogDelta,
  PackIndexEntry,
  RuntimeAssetBinding,
  RuntimeCatalogSnapshot,
} from '@forgeax/engine-types';
import { resolvePackBuildInputs } from '../build-inputs.js';
import type { PluginPackInternalOptions } from '../plugin-contract.js';
import { projectRuntimeDiagnostics } from '../runtime-diagnostics.js';
import { createMiddlewareDispatcher, type DispatcherServer } from './dispatcher.js';
import {
  createConfigureServer,
  type PluginServerLifecycleState,
} from './plugin-server-configure.js';
import { createProductionBridge, type ProductionBridge } from './production-bridge.js';

export interface PluginServerLike extends DispatcherServer {
  readonly ws?: {
    send(payload: { type: string } & Record<string, unknown>): void;
  };
}

export interface PluginServerState {
  catalogProjection: CatalogBuildResult;
  importedGuids: Set<string>;
  metaPackBodies: Map<string, string>;
  devArtifactBodies: Map<string, { readonly bytes: Uint8Array; readonly mimeType: string }>;
}

export type PluginServerProjectionState = PluginServerState & {
  publicationCandidates: Map<string, AssetPublicationEnvelope>;
  pendingImportPublications: Map<string, StagedImportPublication>;
};

export interface PluginServerCallbacks {
  publishAuthoredDevPacks(
    entries: readonly PackIndexEntry[],
    projection: PluginServerProjectionState,
    declarations?: ReadonlyMap<string, ScanSourceDeclaration>,
    signal?: AbortSignal,
    runtimeBinding?: RuntimeAssetBinding,
  ): Promise<readonly PackIndexEntry[]>;
  ensureMetaImport(
    metaPath: string,
    declaration?: RunImportMeta,
    signal?: AbortSignal,
    projection?: PluginServerProjectionState,
    runtimeBinding?: RuntimeAssetBinding,
  ): Promise<PackIndexEntry[]>;
  commitGeneration(candidate: PluginServerProjectionState, signal?: AbortSignal): Promise<void>;
  discardPublications(candidates: ReadonlyMap<string, AssetPublicationEnvelope>): void;
  discardImportPublications(
    candidates: ReadonlyMap<string, StagedImportPublication>,
  ): Promise<void>;
  ensureMetaPackBody(url: string): Promise<string | undefined>;
  setCatalogDeltaPublisher(publisher: (delta: CatalogDelta) => void): void;
}

export interface RebuildAssetOptions {
  /** Catalog-space source keys; when set, only these paths are rescanned instead of every pack root. */
  readonly sourceKeys?: readonly string[];
}

export interface PluginServerRouteCallbacks {
  materializeAsset(guid: string, signal?: AbortSignal): Promise<readonly PackIndexEntry[]>;
  rebuildAsset(
    guid: string,
    signal?: AbortSignal,
    options?: RebuildAssetOptions,
  ): Promise<readonly PackIndexEntry[]>;
  ensureMetaPackBody(url: string): Promise<string | undefined>;
}

export interface PluginServerContext {
  readonly opts: PluginPackInternalOptions;
  readonly transportBase?: string | undefined;
  /** Current project DDC root used by importer/publication callbacks. */
  readonly projectDdcRoot: string;
  /** Replace the project DDC root before starting the next runtime generation. */
  readonly setProjectDdcRoot: (root: string) => void;
  readonly registeredImporterKeys: ReadonlySet<string>;
  readonly catalogVisibility: CatalogProducerVisibility;
  readonly resetState: () => void;
  readonly scopedPackageUrl: (binding: RuntimeAssetBinding, packageUrl: string) => string;
  readonly scopedCatalogResponse: (binding: RuntimeAssetBinding) => RuntimeCatalogSnapshot;
  readonly state: PluginServerState;
  readonly callbacks: PluginServerCallbacks;
  readonly setSourceRefresh: (refresh: (sourcePath: string) => Promise<void>) => void;
}

export function createPluginServer(context: PluginServerContext) {
  const { opts, registeredImporterKeys, catalogVisibility, state, callbacks } = context;
  const dispatcher = createMiddlewareDispatcher();
  const configuredServers = new Set<PluginServerLike>();
  const lifecycle: PluginServerLifecycleState = {
    roots: [...resolvePackBuildInputs({ roots: opts.roots, base: context.transportBase }).roots],
    startupReady: Promise.resolve(),
    stopWatcher: () => {},
    watchEpoch: 0,
    configuredServer: undefined,
    devSession: undefined,
  };
  const productionBridge: ProductionBridge = createProductionBridge({
    producerReadiness: opts.producerReadiness,
    ignorePath: opts.ignorePath,
    transportBase: () => context.transportBase,
    registeredImporterKeys,
    catalogVisibility,
    runtimeBinding: () => lifecycle.devSession?.runtimeScope(),
    roots: () => lifecycle.roots,
    state,
    callbacks,
  });
  const configureServer = createConfigureServer({
    context,
    productionBridge,
    lifecycle,
    configuredServers,
    dispatcher,
    runtimeDiagnostics: projectRuntimeDiagnostics,
  });

  const rebind = async (
    binding: RuntimeAssetBinding,
    nextRoots: readonly string[],
    nextProjectDdcRoot?: string,
  ): Promise<RuntimeAssetBinding> => {
    const server = lifecycle.configuredServer;
    if (server === undefined) {
      throw new Error('forgeax:pack rebind requires configureServer first');
    }
    const previousProjectDdcRoot = context.projectDdcRoot;
    if (nextProjectDdcRoot !== undefined) {
      context.setProjectDdcRoot(resolve(nextProjectDdcRoot));
    }
    const previousRuntime = lifecycle.devSession?.runtimeScope();
    const previousRoots = [...lifecycle.roots];
    lifecycle.watchEpoch += 1;
    lifecycle.stopWatcher();
    await lifecycle.devSession?.close();
    productionBridge.replaceSession();
    context.resetState();
    configureServer(server, nextRoots, binding);
    await lifecycle.startupReady;
    const failedRebindState = lifecycle.devSession?.state();
    if (failedRebindState?.status === 'failed') {
      const failedRebindFailure = failedRebindState.error;
      const rebindDiagnostics = projectRuntimeDiagnostics([
        {
          code: failedRebindFailure.code,
          message: failedRebindFailure.expected,
          hint: failedRebindFailure.hint,
        },
      ]);
      const failedRebindSession = lifecycle.devSession;
      if (previousRuntime === undefined && failedRebindSession !== undefined) {
        const failedBinding = failedRebindSession.runtimeScope();
        if (failedBinding !== undefined) {
          failedRebindSession.publishRuntime('degraded', 'degraded', rebindDiagnostics);
          return failedRebindSession.runtimeScope() ?? binding;
        }
      }
      await lifecycle.devSession?.close();
      productionBridge.replaceSession();
      context.resetState();
      lifecycle.roots = previousRoots;
      context.setProjectDdcRoot(previousProjectDdcRoot);
      configureServer(server, previousRoots, previousRuntime);
      await lifecycle.startupReady;
      const restoredSession = lifecycle.devSession;
      if (restoredSession !== undefined) {
        const restoredBinding = restoredSession.runtimeScope();
        const restoredDiagnostics = [...(restoredBinding?.diagnostics ?? []), ...rebindDiagnostics];
        restoredSession.publishRuntime('degraded', 'degraded', restoredDiagnostics);
      }
      throw failedRebindFailure;
    }
    return lifecycle.devSession?.runtimeScope() ?? binding;
  };

  // Keep the active scope observable through the same Pack producer that owns
  // rebinding. Consumers must not reach into the private DevSession to decide
  // whether a catalog has been published.
  const runtimeBinding = (): RuntimeAssetBinding | undefined =>
    lifecycle.devSession?.runtimeScope();

  const close = async (): Promise<void> => {
    if (lifecycle.devSession?.state().status === 'closed') return;
    lifecycle.watchEpoch += 1;
    lifecycle.stopWatcher();
    await lifecycle.devSession?.close();
    await productionBridge.session.close();
    configuredServers.clear();
    await dispatcher.close();
  };

  return { configureServer, rebind, runtimeBinding, close };
}

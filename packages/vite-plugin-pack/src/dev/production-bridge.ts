import { relative, resolve } from 'node:path';
import {
  buildCatalogResult,
  type ProducerReadiness,
  parseProducerReadiness,
} from '@forgeax/engine-import';
import {
  type CatalogProducerVisibility,
  metaPathForGuid,
  STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
} from '@forgeax/engine-pack/build';
import type { PackIndexEntry, RuntimeAssetBinding } from '@forgeax/engine-types';
import { createPluginPackFailure } from '../errors.js';
import {
  createProductionSession,
  type ProductionDeclaration,
  type ProductionRunResult,
  type ProductionSession,
} from '../production/session.js';
import type { DevSession } from './dev-session.js';
import type {
  PluginServerCallbacks,
  PluginServerProjectionState,
  PluginServerRouteCallbacks,
  PluginServerState,
} from './plugin-server.js';

type CatalogInventory = Awaited<ReturnType<typeof buildCatalogResult>>;

interface ProductionGenerationState {
  inventory: CatalogInventory | undefined;
  candidate: PluginServerProjectionState | undefined;
  authoredPublished: boolean;
}

function projectAcceptedEntries(
  raw: readonly PackIndexEntry[],
  accepted: readonly PackIndexEntry[],
): PackIndexEntry[] {
  const acceptedByGuid = new Map(
    accepted.map((entry) => [entry.guid.toLowerCase(), entry] as const),
  );
  return raw.map((entry) => acceptedByGuid.get(entry.guid.toLowerCase()) ?? entry);
}

function declarationsForInventory(inventory: CatalogInventory): readonly ProductionDeclaration[] {
  return [...inventory.sourceDeclarations.values()].flatMap((sourceDeclaration) => {
    if (
      sourceDeclaration.format === 'meta.json' &&
      !inventory.declarations.has(sourceDeclaration.sourcePath)
    ) {
      return [];
    }
    const sourceKey = relative(process.cwd(), sourceDeclaration.sourcePath).replace(/\\/g, '/');
    const guids =
      sourceDeclaration.format === 'meta.json' || sourceDeclaration.format === 'pack.ts'
        ? sourceDeclaration.value.subAssets.map((asset) => asset.guid)
        : sourceDeclaration.value.assets.map((asset) => asset.guid);
    return [{ sourceKey, guids, format: sourceDeclaration.format }];
  });
}

export interface ProductionBridge {
  readonly session: ProductionSession<ProductionGenerationState>;
  readonly inventoryForRequest: (
    initial: boolean,
    session?: ProductionSession<ProductionGenerationState>,
  ) => Promise<CatalogInventory>;
  readonly replaceSession: () => ProductionSession<ProductionGenerationState>;
}

export interface ProductionBridgeContext {
  readonly producerReadiness?: ProducerReadiness | undefined;
  readonly ignorePath?: ((path: string) => boolean) | undefined;
  readonly transportBase: () => string | undefined;
  readonly registeredImporterKeys: ReadonlySet<string>;
  readonly catalogVisibility: CatalogProducerVisibility;
  readonly runtimeBinding: () => RuntimeAssetBinding | undefined;
  readonly roots: () => readonly string[];
  readonly state: PluginServerState;
  readonly callbacks: PluginServerCallbacks;
}

export function createProductionBridge(context: ProductionBridgeContext): ProductionBridge {
  const {
    producerReadiness,
    ignorePath,
    transportBase,
    registeredImporterKeys,
    catalogVisibility,
    runtimeBinding,
    roots,
    state,
    callbacks,
  } = context;
  const createCandidateState = (
    inventory: CatalogInventory,
    accepted: PluginServerProjectionState | undefined,
  ): PluginServerProjectionState => {
    const previousCatalog = accepted?.catalogProjection.entries ?? state.catalogProjection.entries;
    const catalog = projectAcceptedEntries(inventory.entries, previousCatalog);
    return {
      catalogProjection: { ...inventory, entries: catalog },
      importedGuids: new Set(accepted?.importedGuids ?? state.importedGuids),
      metaPackBodies: new Map(accepted?.metaPackBodies ?? state.metaPackBodies),
      devArtifactBodies: new Map(
        [...(accepted?.devArtifactBodies ?? state.devArtifactBodies)].map(([key, value]) => [
          key,
          { ...value, bytes: new Uint8Array(value.bytes) },
        ]),
      ),
      publicationCandidates: new Map(),
      pendingImportPublications: new Map(),
    };
  };

  const createSession = (): ProductionSession<ProductionGenerationState> =>
    createProductionSession<ProductionGenerationState>({
      sourceKeys: () => [...roots()],
      createState: ({ acceptedState }) => ({
        inventory: acceptedState?.inventory,
        authoredPublished: false,
        candidate:
          acceptedState?.inventory === undefined
            ? undefined
            : createCandidateState(acceptedState.inventory, acceptedState.candidate),
      }),
      inventory: async ({ sourceKeys, state: generationState }) => {
        const scanOptions = {
          scriptablePack: STANDARD_SCRIPTABLE_PACK_SCAN_OPTIONS,
          ...(ignorePath === undefined ? {} : { ignorePath }),
        };
        const inventory = await buildCatalogResult(
          sourceKeys,
          transportBase(),
          registeredImporterKeys,
          scanOptions,
          catalogVisibility,
        );
        generationState.inventory = inventory;
        generationState.candidate = createCandidateState(inventory, generationState.candidate);
        return declarationsForInventory(inventory);
      },
      produce: async ({ generation, declaration, intent, signal, state: generationState }) => {
        const inventory = generationState.inventory;
        const candidate = generationState.candidate;
        if (inventory === undefined || candidate === undefined) {
          throw createPluginPackFailure({
            code: 'produce-failed',
            expected: 'the production generation to retain its inventory declaration',
            hint: 'repair the generation candidate lifetime and retry the rebuild',
            detail: { stage: 'produce', subject: `generation:${generation}` },
          });
        }
        let producedEntries: readonly PackIndexEntry[] = [];
        if (declaration.format === 'meta.json') {
          const readiness = parseProducerReadiness(producerReadiness);
          if (!readiness.ok) throw readiness.error;
          if (intent === 'attempt' && readiness.value === 'on-demand') return;
          const metaPath = resolve(process.cwd(), declaration.sourceKey);
          producedEntries = await callbacks.ensureMetaImport(
            metaPath,
            inventory.declarations.get(metaPath),
            signal,
            candidate,
            runtimeBinding(),
          );
        } else if (
          (declaration.format === 'pack.json' || declaration.format === 'pack.ts') &&
          !generationState.authoredPublished
        ) {
          generationState.authoredPublished = true;
          producedEntries = await callbacks.publishAuthoredDevPacks(
            inventory.entries.filter(
              (entry) =>
                entry.sourcePath.endsWith('.pack.json') || entry.sourcePath.endsWith('.pack.ts'),
            ),
            candidate,
            inventory.sourceDeclarations,
            signal,
            runtimeBinding(),
          );
        }
        const candidateEntries = projectAcceptedEntries(
          candidate.catalogProjection.entries,
          producedEntries,
        );
        candidate.catalogProjection = { ...inventory, entries: candidateEntries };
      },
      publish: async ({ generation, signal, state: generationState }) => {
        if (signal.aborted) return;
        const inventory = generationState.inventory;
        const candidate = generationState.candidate;
        if (inventory === undefined || candidate === undefined) {
          throw createPluginPackFailure({
            code: 'commit-failed',
            expected: 'the accepted production candidate to retain its Catalog projection',
            hint: 'repair the generation candidate lifetime and retry the rebuild',
            detail: { stage: 'commit', subject: `generation:${generation}` },
          });
        }
        await callbacks.commitGeneration(candidate, signal);
        if (signal.aborted) return;
        Object.assign(state, candidate);
        state.catalogProjection = {
          ...candidate.catalogProjection,
          entries:
            candidate.catalogProjection.authority === 'authoritative'
              ? [...candidate.catalogProjection.entries]
              : [],
        };
      },
      discard: async ({ state: generationState }) => {
        const candidate = generationState.candidate;
        if (candidate !== undefined) {
          callbacks.discardPublications(candidate.publicationCandidates);
          await callbacks.discardImportPublications(candidate.pendingImportPublications);
        }
      },
    });

  let session = createSession();
  return {
    get session() {
      return session;
    },
    inventoryForRequest: async (initial, requestedSession = session) => {
      const result = initial
        ? await requestedSession.start()
        : await requestedSession.rebuild(roots().map((sourceKey) => ({ sourceKey })));
      if (result.status === 'failed') throw result.error;
      if (result.status === 'stale') {
        throw createPluginPackFailure({
          code: 'stale-generation',
          expected: 'the requested Catalog generation to remain current',
          hint: 'retry the rebuild after the active generation settles',
          detail: { stage: 'scan', subject: `generation:${result.generation}` },
        });
      }
      const inventory = requestedSession.acceptedState()?.inventory;
      if (inventory === undefined) {
        throw createPluginPackFailure({
          code: 'scan-failed',
          expected: 'the accepted ProductionSession to retain its inventory snapshot',
          hint: 'repair the production candidate lifetime and retry the rebuild',
          detail: { stage: 'scan', subject: `generation:${result.generation}` },
        });
      }
      return inventory;
    },
    replaceSession: () => {
      session = createSession();
      return session;
    },
  };
}

export interface ProductionRouteBridgeContext {
  readonly callbacks: PluginServerCallbacks;
  readonly activeDevSession: DevSession;
  readonly roots: readonly string[];
  readonly producerReadiness?: ProducerReadiness | undefined;
  readonly state: PluginServerState;
}

function containsFailureCode(error: unknown, code: string, seen = new Set<unknown>()): boolean {
  if (error === null || typeof error !== 'object' || seen.has(error)) return false;
  seen.add(error);
  const failure = error as { readonly code?: unknown; readonly cause?: unknown };
  return failure.code === code || containsFailureCode(failure.cause, code, seen);
}

export function createProductionRouteBridge(
  context: ProductionRouteBridgeContext,
): PluginServerRouteCallbacks {
  const { callbacks, activeDevSession, roots, producerReadiness, state } = context;
  const acceptedEntries = (guid: string): readonly PackIndexEntry[] => {
    const guidLower = guid.toLowerCase();
    return state.catalogProjection.entries.filter(
      (entry) => entry.guid.toLowerCase() === guidLower,
    );
  };
  const entriesAfter = (guid: string, result: ProductionRunResult): readonly PackIndexEntry[] => {
    if (result.status === 'failed') {
      if (containsFailureCode(result.error, 'commit-failed')) {
        const accepted = acceptedEntries(guid);
        if (accepted.length > 0) return accepted;
      }
      throw result.error;
    }
    if (result.status === 'stale') {
      throw createPluginPackFailure({
        code: 'stale-generation',
        expected: 'the production generation to remain current',
        hint: 'retry the asset request after the active generation settles',
        detail: { stage: 'route', subject: guid },
      });
    }
    const entries = acceptedEntries(guid);
    if (entries.length === 0) {
      throw createPluginPackFailure({
        code: 'route-failed',
        expected: `the accepted Catalog to contain ${guid}`,
        hint: 'rebuild the Catalog and retry the declared asset request',
        detail: { stage: 'route', subject: guid },
      });
    }
    return entries;
  };
  const trackRoute = <T>(task: Promise<T>, signal: AbortSignal | undefined): Promise<T> =>
    activeDevSession.track(
      signal === undefined ? task : task.then((entries) => (signal.aborted ? ([] as T) : entries)),
    );
  return {
    materializeAsset: (guid, signal) => {
      return trackRoute(
        activeDevSession.materializeProduction(guid).then((result) => entriesAfter(guid, result)),
        signal,
      );
    },
    rebuildAsset: (guid, signal) => {
      const task = (async (): Promise<readonly PackIndexEntry[]> => {
        let result = await activeDevSession.rebuildProduction(
          roots.map((sourceKey) => ({ sourceKey })),
        );
        if (result.status === 'stale') {
          result = await activeDevSession.rebuildProduction(
            roots.map((sourceKey) => ({ sourceKey })),
          );
        }
        let entries = entriesAfter(guid, result);
        const readiness = parseProducerReadiness(producerReadiness);
        if (readiness.ok && readiness.value === 'on-demand') {
          const metaPath = metaPathForGuid(state.catalogProjection.declarations, guid);
          if (metaPath !== undefined) {
            entries = entriesAfter(guid, await activeDevSession.materializeProduction(guid));
          }
        }
        return entries;
      })();
      return trackRoute(task, signal);
    },
    ensureMetaPackBody: callbacks.ensureMetaPackBody,
  };
}

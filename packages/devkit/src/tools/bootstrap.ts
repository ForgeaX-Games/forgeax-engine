import type { Context } from '@forgeax/engine-plugin';
import {
  bootstrapCatalogLoader,
  type CatalogLoaderBootstrapValue,
  type GamePluginEntry,
  type PluginCatalog,
  type PluginRealm,
  projectPluginEntries,
} from '@forgeax/engine-plugin/loader';
import {
  type RealmCapabilityMatrix,
  validateRealmBootstrapPayload,
} from '@forgeax/engine-tool-runtime';
import {
  createProjectBootstrapPlan,
  type ProjectBootstrapPlan,
} from '../host/project-bootstrap.js';
import {
  createResourceBootstrapPlan,
  type ResourceBootstrapPlan,
} from '../host/resource-bootstrap.js';
import type { ProjectFacts } from '../types.js';

export interface PreviewBootstrapRoots {
  readonly project: ProjectBootstrapPlan;
  readonly resource: (guid: string) => ResourceBootstrapPlan;
}

/** Derives both physical roots without sharing project gameplay closure. */
export function createPreviewBootstrapRoots(facts: ProjectFacts): PreviewBootstrapRoots {
  return {
    project: createProjectBootstrapPlan(facts),
    resource: (guid) => createResourceBootstrapPlan(facts, guid),
  };
}

export interface RealmBootstrapInput {
  readonly realm: PluginRealm;
  readonly catalog: PluginCatalog;
  readonly catalogDigest: string;
  readonly supportedRealms: readonly PluginRealm[];
  readonly entries: readonly GamePluginEntry[];
  readonly payload?: unknown;
  readonly lifecycle?: RealmLifecycleAdapter;
}

export interface RealmLifecycleHandle {
  readonly stop: () => Promise<void>;
}

export interface RealmLifecycleAdapter {
  readonly start: (input: {
    readonly realm: PluginRealm;
    readonly entries: readonly ReturnType<typeof projectPluginEntries>[number][];
    readonly catalog: PluginCatalog;
    readonly catalogDigest: string;
  }) => Promise<RealmLifecycleHandle>;
}

export type RealmBootstrapResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly realm: PluginRealm;
        readonly catalogDigest: string;
        readonly entries: readonly ReturnType<typeof projectPluginEntries>[number][];
        readonly loader?: CatalogLoaderBootstrapValue;
        readonly lifecycle?: RealmLifecycleHandle;
      };
    }
  | { readonly ok: false; readonly error: unknown };

/** Bootstrap one declared realm from the same static Catalog and clone-safe input. */
export async function bootstrapRealm(
  ctx: Context | undefined,
  input: RealmBootstrapInput,
): Promise<RealmBootstrapResult> {
  const cloneSafe = validateRealmBootstrapPayload(input.payload);
  if (!cloneSafe.ok) return cloneSafe;
  if (!input.supportedRealms.includes(input.realm)) {
    return {
      ok: false,
      error: {
        code: 'realm-capability-unavailable',
        realm: input.realm,
        supportedRealms: input.supportedRealms,
      },
    };
  }
  const entries = projectPluginEntries(input.entries, input.realm, input.realm);
  if (input.realm === 'build') {
    if (input.lifecycle === undefined) {
      return {
        ok: false,
        error: {
          code: 'realm-lifecycle-adapter-missing',
          realm: input.realm,
          hint: 'Inject a build lifecycle adapter that owns execution and stop cleanup.',
        },
      };
    }
    const lifecycle = await input.lifecycle.start({
      realm: input.realm,
      entries,
      catalog: input.catalog,
      catalogDigest: input.catalogDigest,
    });
    return {
      ok: true,
      value: { realm: input.realm, catalogDigest: input.catalogDigest, entries, lifecycle },
    };
  }
  if (ctx === undefined) {
    return {
      ok: false,
      error: { code: 'realm-context-missing', realm: input.realm },
    };
  }
  const loaded = await bootstrapCatalogLoader(ctx, input.catalog, input.realm, {
    catalogDigest: input.catalogDigest,
    supportedRealms: input.supportedRealms,
  });
  if (!loaded.ok) return loaded;
  return {
    ok: true,
    value: {
      realm: input.realm,
      catalogDigest: input.catalogDigest,
      entries,
      loader: loaded.value,
    },
  };
}

export function assertRealmCapability(matrix: RealmCapabilityMatrix, realm: PluginRealm): void {
  const capability = matrix.realms[realm];
  if (!capability.supported) {
    throw new Error(`realm-capability-unavailable:${realm}`);
  }
}

export type RealmPlacement = 'host' | 'frontend' | 'engine-main' | 'engine-worker' | 'build';
export type RealmName = import('@forgeax/engine-types').PluginBuildTarget;

export interface RealmModule {
  readonly module: string;
  readonly imports: readonly string[];
}

export interface ResolveRealmClosureInput {
  readonly entry: string;
  readonly placement: RealmPlacement;
  readonly modules: readonly RealmModule[];
  readonly realms?: Readonly<Record<string, RealmName>>;
}

export interface RealmForbiddenDetail {
  readonly chain: readonly string[];
  readonly from: RealmName;
  readonly to: RealmName;
}

export interface RealmUnresolvedDetail {
  readonly chain: readonly string[];
  readonly import: string;
}

export type RealmClosureErrorCode = 'realm-import-forbidden' | 'realm-import-unresolved';

export type RealmClosureError =
  | {
      readonly code: 'realm-import-forbidden';
      readonly expected: string;
      readonly hint: string;
      readonly detail: RealmForbiddenDetail;
    }
  | {
      readonly code: 'realm-import-unresolved';
      readonly expected: string;
      readonly hint: string;
      readonly detail: RealmUnresolvedDetail;
    };

export type RealmClosureResult =
  | {
      readonly ok: true;
      readonly value: {
        readonly placement: RealmPlacement;
        readonly modules: readonly string[];
      };
    }
  | { readonly ok: false; readonly error: RealmClosureError };

function realmForPlacement(placement: RealmPlacement): RealmName {
  return placement === 'engine-main' || placement === 'engine-worker' ? 'engine' : placement;
}

function failure(
  code: RealmClosureErrorCode,
  expected: string,
  hint: string,
  detail: RealmForbiddenDetail | RealmUnresolvedDetail,
): RealmClosureResult {
  return { ok: false, error: { code, expected, hint, detail } as RealmClosureError };
}

/** Resolve a normalized static graph with a deterministic breadth-first walk. */
export function resolveRealmClosure(input: ResolveRealmClosureInput): RealmClosureResult {
  const modules = new Map(input.modules.map((module) => [module.module, module]));
  const rootRealm = realmForPlacement(input.placement);
  const queue: Array<{ readonly module: string; readonly chain: readonly string[] }> = [
    { module: input.entry, chain: [input.entry] },
  ];
  const visited = new Set<string>();
  const resolved: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current.module)) continue;
    visited.add(current.module);
    resolved.push(current.module);
    const source = modules.get(current.module);
    if (source === undefined) {
      return failure(
        'realm-import-unresolved',
        'every module in the project closure to resolve',
        'Add the missing module to the project or repair the static import.',
        { chain: current.chain, import: current.module },
      );
    }
    for (const imported of source.imports) {
      const chain = [...current.chain, imported];
      const importedRealm = input.realms?.[imported];
      if (importedRealm !== undefined && importedRealm !== rootRealm) {
        return failure(
          'realm-import-forbidden',
          'the closure to remain inside its physical realm',
          'Move the import behind the owning realm boundary.',
          { chain, from: rootRealm, to: importedRealm },
        );
      }
      if (!visited.has(imported)) queue.push({ module: imported, chain });
    }
  }

  return { ok: true, value: { placement: input.placement, modules: resolved } };
}

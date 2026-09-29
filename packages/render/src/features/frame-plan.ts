import type {
  RenderFeatureResourceDeclaration,
  RenderFeatureWork,
  RenderFeatureWorkPlan,
  RenderFeatureWorkScope,
} from './plan';

/** Scope is the resource namespace; it is never a synthetic Feature identity. */
export function featureScopeKey(scope: RenderFeatureWorkScope): string {
  return scope === 'frame' ? 'frame' : `view:${scope.view}`;
}

export function featureResourceKey(scope: RenderFeatureWorkScope, name: string): string {
  return JSON.stringify([featureScopeKey(scope), name]);
}

export interface FeatureWorkResources {
  readonly work: RenderFeatureWork;
  readonly closure: RenderFeatureWorkPlan;
  readonly keys: ReadonlyMap<string, string>;
  readonly resources: readonly RenderFeatureResourceDeclaration[];
}

/** Resolve only local and shared names. Cross-view reads have no lookup route. */
export function resolveFeatureWorkResources(
  works: readonly RenderFeatureWork[],
): readonly FeatureWorkResources[] {
  const scopes = new Set<string>();
  const shared = works.find((work) => work.scope === 'frame')?.resources ?? [];
  const sharedNames = new Set(shared.map((resource) => resource.name));
  return works.map((work) => {
    const scope = featureScopeKey(work.scope);
    if (scopes.has(scope)) throw new Error(`duplicate RenderFeature work scope: ${scope}`);
    scopes.add(scope);
    const localNames = new Set<string>();
    for (const resource of work.resources) {
      if (
        localNames.has(resource.name) ||
        (work.scope !== 'frame' && sharedNames.has(resource.name))
      )
        throw new Error(`ambiguous RenderFeature resource: ${scope}/${resource.name}`);
      localNames.add(resource.name);
    }
    const keys = new Map<string, string>();
    for (const resource of shared)
      keys.set(resource.name, featureResourceKey('frame', resource.name));
    for (const resource of work.resources)
      keys.set(resource.name, featureResourceKey(work.scope, resource.name));
    const key = (name: string): string => {
      const resolved = keys.get(name);
      if (resolved === undefined)
        throw new Error(`unresolved RenderFeature resource: ${scope}/${name}`);
      return resolved;
    };
    const resources = work.resources.map((resource): RenderFeatureResourceDeclaration => {
      const name = key(resource.name);
      switch (resource.kind) {
        case 'compute-bindings':
          return {
            ...resource,
            name,
            program: key(resource.program),
            entries: resource.entries.map((entry) => ({ ...entry, resource: key(entry.resource) })),
          };
        case 'graphics-bindings':
          return { ...resource, name, program: key(resource.program) };
        case 'vertex-data':
        case 'index-data':
          return resource.buffer === undefined
            ? { ...resource, name }
            : { ...resource, name, buffer: key(resource.buffer) };
        default:
          return { ...resource, name };
      }
    });
    return {
      work,
      closure: {
        resources: work.scope === 'frame' ? work.resources : [...shared, ...work.resources],
        passes: work.passes,
      },
      keys,
      resources,
    };
  });
}

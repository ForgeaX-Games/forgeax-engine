// packages/ecs/__tests__/__fixtures__/inspect-scripts.snapshot.ts
//
// Byte-identical migration baseline for the 5 ECS IIFE script literals
// (entities / components / systems / resources / world). Captured from the
// `@forgeax/engine-console/src/inspect-scripts.ts` file at git commit
// 2439e0f0 (one commit before deletion in feat-20260517 w17). Lines and
// whitespace are preserved exactly as they appeared in the legacy
// `buildScriptByName(...)` helper output (cosmetic variable rename in the
// migrated `cli-ecs.ts` is allowed only when wrapped in JSON via
// `JSON.stringify` parameters; the inner script body must match this
// fixture verbatim under a normalized-newline diff).
//
// Historic `packsScript` (asset GUID lookup) is **not** carried over: that
// concern moves to the `forgeax-engine-console-asset` plugin bin in
// `@forgeax/engine-pack` (existing since 2026-05-14). The 5 ECS scripts
// below are the only segments locked by `cli-ecs-scripts.test.ts`.

// R2/F-1 (feat-20260608 R2): extended with optional `componentName` arg
// (AC-29 `--component=<Name>`). The snapshot tracks the new SSOT.
export const ENTITIES_SCRIPT_BY_NAMES = (
  withNames: ReadonlyArray<string>,
  withoutNames: ReadonlyArray<string>,
  componentName?: string,
): string => {
  const withJson = JSON.stringify(withNames);
  const withoutJson = JSON.stringify(withoutNames);
  const compJson = JSON.stringify(componentName ?? null);
  return [
    '(() => {',
    '  const inspection = world.inspect();',
    `  const withNames = ${withJson};`,
    `  const withoutNames = ${withoutJson};`,
    `  const componentName = ${compJson};`,
    '  const matchingArchetypes = inspection.archetypes.filter((a) => {',
    '    const has = (n) => a.componentNames.includes(n);',
    '    const withOk = withNames.every(has);',
    '    const withoutOk = withoutNames.every((n) => !has(n));',
    '    return withOk && withoutOk;',
    '  });',
    '  const baseRow = (a) => ({',
    '    key: a.key,',
    '    componentNames: a.componentNames,',
    '    entityCount: a.entityCount,',
    '  });',
    '  if (componentName !== null) {',
    '    return {',
    '      matchedArchetypeCount: matchingArchetypes.length,',
    '      withFilter: withNames,',
    '      withoutFilter: withoutNames,',
    '      componentFilter: componentName,',
    '      archetypes: matchingArchetypes',
    '        .filter((a) => a.componentNames.includes(componentName))',
    '        .map(baseRow),',
    '    };',
    '  }',
    '  return {',
    '    matchedArchetypeCount: matchingArchetypes.length,',
    '    withFilter: withNames,',
    '    withoutFilter: withoutNames,',
    '    archetypes: matchingArchetypes.map(baseRow),',
    '  };',
    '})()',
  ].join('\n');
};

export const COMPONENTS_SCRIPT = (): string =>
  [
    '(() => {',
    '  const inspection = world.inspect();',
    '  const perComponent = {};',
    '  for (const name of inspection.activeComponents) {',
    '    perComponent[name] = { name, archetypeCount: 0, entityCount: 0 };',
    '  }',
    '  for (const a of inspection.archetypes) {',
    '    for (const name of a.componentNames) {',
    '      if (!perComponent[name]) {',
    '        perComponent[name] = { name, archetypeCount: 0, entityCount: 0 };',
    '      }',
    '      perComponent[name].archetypeCount += 1;',
    '      perComponent[name].entityCount += a.entityCount;',
    '    }',
    '  }',
    '  return {',
    '    componentCount: inspection.activeComponents.length,',
    '    components: Object.values(perComponent),',
    '  };',
    '})()',
  ].join('\n');

export const SYSTEMS_SCRIPT = (): string =>
  [
    '(() => {',
    '  const inspection = world.inspect();',
    '  return {',
    '    systemCount: inspection.systemCount,',
    '    systems: inspection.systems ?? [],',
    '  };',
    '})()',
  ].join('\n');

export const RESOURCES_SCRIPT = (): string =>
  [
    '(() => {',
    '  const inspection = world.inspect();',
    '  return {',
    '    resourceCount: inspection.resourceKeys.length,',
    '    resourceKeys: inspection.resourceKeys,',
    '  };',
    '})()',
  ].join('\n');

export const WORLD_SCRIPT = (): string => 'world.inspect()';

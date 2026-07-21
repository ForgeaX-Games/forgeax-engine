// ────────────────────────────────────────────────────────────────────────────
// feat-20260531-query-optional-components M1 — closed-union evolution +1.
//
// Adds 1 new member 'query-descriptor-with-optional-conflict' to EcsErrorCode
// (31 -> 32). AGENTS.md §Error model evolution contract: minor (add member
// only). Same-shape add-only mirror of ScheduleMutationError — the kebab
// `<noun>-<problem>` series keeps `switch (err.code)` exhaustive narrows
// visually consistent (charter P4).
//
// Triggered by `createQueryState` when a component token appears in both
// `with` and `optional` arrays — the two roles are contradictory (with =
// must be present for matching; optional = may be absent, data-only).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Thrown / returned via `Result.err` from `createQueryState` when the same
 * component token appears in both `with` and `optional` — the two roles are
 * contradictory. AI users remove the component from one of the two lists.
 *
 * `.code = 'query-descriptor-with-optional-conflict'`
 * `.detail = { tokenName }`
 * `.hint` — names the conflicting component + the resolution (remove from
 *   `with` or `optional`).
 */
export class QueryDescriptorOptionalConflictError extends Error {
  override readonly name = 'QueryDescriptorOptionalConflictError';
  readonly code = 'query-descriptor-with-optional-conflict' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly tokenName: string };

  constructor(tokenName: string) {
    const hint = `Component "${tokenName}" appears in both \`with\` and \`optional\`. These roles conflict: \`with\` requires the component for matching, while \`optional\` is data-only. Remove "${tokenName}" from one of the two lists.`;
    const expectedStr = 'disjoint with and optional component sets';
    super(
      `QueryDescriptor: with-optional conflict.\n` +
        `  code: query-descriptor-with-optional-conflict\n` +
        `  token: ${tokenName}\n` +
        `  expected: ${expectedStr}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { tokenName };
  }
}

/**
 * Thrown by `queryCombinations` when the query state's `with` list omits the
 * `Entity` component. Combinations yield entity-handle tuples (the caller reads
 * each via `world.get`), so `Entity` must be in `with` — the same requirement
 * `queryRun` documents for `bundle.Entity.self`. Fail-fast at the
 * `queryCombinations` entry (mirrors QueryDescriptorOptionalConflictError's
 * setup-time self-consistency shape).
 *
 * `.code = 'query-combinations-entity-required'`; `.detail.withNames` carries
 * the declared component names.
 */
export class QueryCombinationsEntityRequiredError extends Error {
  override readonly name = 'QueryCombinationsEntityRequiredError';
  readonly code = 'query-combinations-entity-required' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly withNames: readonly string[] };

  constructor(withNames: readonly string[]) {
    const hint = `queryCombinations yields entity-handle tuples, so the query's \`with\` list must include the \`Entity\` component. Add \`Entity\` to \`with\` (currently: [${withNames.join(', ')}]).`;
    const expectedStr = 'Entity component present in the query `with` list';
    super(
      `queryCombinations: Entity component required.\n` +
        `  code: query-combinations-entity-required\n` +
        `  with: [${withNames.join(', ')}]\n` +
        `  expected: ${expectedStr}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { withNames };
  }
}

/**
 * Returned via `Result.err` from `world.removeComponent` when the caller tries
 * to remove an essential (undeletable) component
 * (feat-20260602-archetype-stores-full-packed-entity M1 / w3, plan-strategy
 * D-3). The only essential component today is the id=0 `Entity` component: every
 * archetype carries it unconditionally as the row's own packed handle, so
 * removing it is structurally meaningless. The code name is deliberately
 * generic (`remove-essential-component`, not entity-specific) so a future second
 * essential component reuses it without a rename.
 *
 * `.code = 'remove-essential-component'`
 * `.detail = { componentName }`
 * `.hint` — names the essential component + states it cannot be removed.
 */
export class RemoveEssentialComponentError extends Error {
  override readonly name = 'RemoveEssentialComponentError';
  readonly code = 'remove-essential-component' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly componentName: string };

  constructor(componentName: string) {
    const hint = `Component "${componentName}" is essential (every entity carries it unconditionally) and cannot be removed. Despawn the entity instead if you want to retire it.`;
    const expected = 'non-essential component';
    super(
      `removeComponent: essential component cannot be removed.\n` +
        `  code: remove-essential-component\n` +
        `  component: ${componentName}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { componentName };
  }
}

/**
 * Returned via the `Result` err branch when `instantiate` encounters a
 * SceneAsset entity whose `components` map references a component name that was
 * never passed to `defineComponent`.
 *
 * `.code = 'component-not-defined'`
 * `.detail.name` — the offending component name.
 *
 * Promoting this to a class (rather than a bare object literal) keeps the
 * scene-instantiate failure surface inside the `EcsError` class union, so the
 * documented two-level narrow `cause instanceof EcsError` actually matches it
 * (docs/feedbacks/2026-06-03 §6.2 Tier 4.2). `expected` / `hint` accept
 * per-call overrides because the parent-passthrough (ChildOf) site needs a
 * distinct message from the generic entity-component site.
 */
export class ComponentNotDefinedError extends Error {
  override readonly name = 'ComponentNotDefinedError';
  readonly code = 'component-not-defined' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly name: string };

  constructor(componentName: string, opts?: { expected?: string; hint?: string }) {
    const expected = opts?.expected ?? `component '${componentName}' defined before instantiate`;
    const hint =
      opts?.hint ??
      `define the component via defineComponent('${componentName}', ...) before instantiating this SceneAsset`;
    super(
      `instantiate: component not defined.\n` +
        `  code: component-not-defined\n` +
        `  component: ${componentName}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { name: componentName };
  }
}

/**
 * Returned via `Result.err` from `world.spawn` / `world.addComponent` /
 * `world.instantiateScene` / `Commands.spawn` when the caller-supplied
 * data payload carries a key that is not declared in the target component's
 * schema. The pre-fix behaviour silently dropped unknown keys inside
 * `fillComponentDefaults` (which walked schema keys, never raw keys), so a
 * typo like `MeshRenderer { material: h }` (singular legacy field name; the
 * current schema has `materials: array<...>`) produced an empty-defaults row
 * + an invisible / mid-grey entity downstream. Surfacing the typo at the
 * spawn boundary collapses a class of "renders wrong, looks like a graphics
 * bug" reports into a single explicit error.
 *
 * `.code = 'spawn-data-unknown-field'`
 * `.detail = { component, field, knownFields }`
 * `.hint` — names the offending field and lists the schema's known fields.
 */
export class SpawnDataUnknownFieldError extends Error {
  override readonly name = 'SpawnDataUnknownFieldError';
  readonly code = 'spawn-data-unknown-field' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly component: string;
    readonly field: string;
    readonly knownFields: readonly string[];
  };

  constructor(componentName: string, fieldName: string, knownFields: readonly string[]) {
    const sortedKnown = [...knownFields].sort();
    const expected = `field name in {${sortedKnown.join(', ')}}`;
    const hint =
      `'${fieldName}' is not a schema field of '${componentName}'. ` +
      `Known fields: ${sortedKnown.join(', ')}. ` +
      `Check for a typo or a stale single-vs-plural rename (e.g. 'material' vs 'materials').`;
    super(
      `${componentName}: spawn data carries unknown field.\n` +
        `  code: spawn-data-unknown-field\n` +
        `  component: ${componentName}\n` +
        `  field: ${fieldName}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = { component: componentName, field: fieldName, knownFields: sortedKnown };
  }
}

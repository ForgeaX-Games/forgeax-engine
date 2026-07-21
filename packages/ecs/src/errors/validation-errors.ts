// ────────────────────────────────────────────────────────────────────────────
// feat-20260519-light-casters-point-spot-pbr w2 — closed-union evolution +1.
//
// Adds 1 new member 'spawn-light-invalid-bounds' to EcsErrorCode (23 -> 24).
// AGENTS.md section Error model evolution contract: minor (add member only).
// Triggered by PointLight / SpotLight spawn-time payload validation
// (plan-strategy D-S3 a). detail.field three-branch
// ('range' | 'innerOuter' | 'outerNinety') keeps the four bound-violation
// shapes under one error code so callers narrow first on `.code` then on
// `.detail.field` (charter P3 progressive disclosure).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returned via `Result.err` from `world.spawn` when a PointLight or SpotLight
 * payload field is out of the documented bound. Four bound violations share
 * one `.code` and discriminate via `.detail.field`:
 *
 * - `range` — PointLight / SpotLight `range < 0` or `Number.isNaN(range)`.
 *   Use `Number.POSITIVE_INFINITY` for an unlimited range or a non-negative
 *   meter value.
 * - `innerOuter` — SpotLight `outerConeDeg <= innerConeDeg`. Inner cone is
 *   the saturated bright region; outer cone is the falloff edge.
 * - `outerNinety` — SpotLight `outerConeDeg > 90`. KHR_lights_punctual upper
 *   bound. A spot light cone wider than 90 degrees becomes a point light;
 *   use PointLight instead.
 * - `direction` — DirectionalLight / SpotLight `direction` is missing or a
 *   zero vector `[0, 0, 0]`. Direction has no default (there is no universal
 *   default direction): omitting it lands the array layer-3 all-zero, which is
 *   the same illegal state as an explicit zero vector. Supply a non-zero
 *   direction (feat-20260709 M2 / D-1, add-only union member).
 *
 * `.code = 'spawn-light-invalid-bounds'`
 * `.detail = { field: 'range' | 'innerOuter' | 'outerNinety' | 'direction';`
 * `            got: number | readonly number[] }`
 * `.hint` — names the offending field plus the valid replacement form.
 */
export class SpawnLightInvalidBoundsError extends Error {
  override readonly name = 'SpawnLightInvalidBoundsError';
  readonly code = 'spawn-light-invalid-bounds' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly field: 'range' | 'innerOuter' | 'outerNinety' | 'direction';
    readonly got: number | readonly number[];
  };

  constructor(
    componentName: string,
    field: 'range' | 'innerOuter' | 'outerNinety' | 'direction',
    got: number | readonly number[],
  ) {
    let hint: string;
    let expectedStr: string;
    switch (field) {
      case 'range':
        hint = `${componentName}.range = ${got} is invalid; use Number.POSITIVE_INFINITY for unlimited range, or a non-negative meter value`;
        expectedStr = 'range >= 0 or Number.POSITIVE_INFINITY';
        break;
      case 'innerOuter':
        hint = `${componentName}.outerConeDeg <= innerConeDeg (got ${got}); inner cone is the saturated bright region, outer cone is the falloff edge; outerConeDeg > innerConeDeg required`;
        expectedStr = 'outerConeDeg > innerConeDeg';
        break;
      case 'outerNinety':
        hint = `${componentName}.outerConeDeg = ${got} > 90; a spot light cone wider than 90 degrees becomes a point light; use PointLight instead`;
        expectedStr = 'outerConeDeg <= 90 (KHR_lights_punctual upper bound)';
        break;
      case 'direction':
        hint = `${componentName}.direction is missing or a zero vector (got ${JSON.stringify(got)}); direction has no default, provide a non-zero direction, e.g. [-0.5, -1, -0.3]`;
        expectedStr = 'direction is a non-zero [x, y, z] vector';
        break;
    }
    super(
      `${componentName}: spawn payload bound violation.\n` +
        `  code: spawn-light-invalid-bounds\n` +
        `  component: ${componentName}\n` +
        `  field: ${field}\n` +
        `  got: ${got}\n` +
        `  expected: ${expectedStr}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { field, got };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260520-directional-light-shadow-mapping M1 / w1 — closed-union
// evolution +1 (`'cardinality-exceeded'`). feat-20260520-2d-sprite-layer-mvp
// M-2 w13 — closed-union evolution +1 (`'resource-invalid-value'`). Both
// land as minor (add-member) per AGENTS.md §Error model evolution contract;
// the unified count after merge is 24 -> 26.
//
// `'cardinality-exceeded'` is triggered when ECS spawn / addComponent
// detects more than one entity carrying a cardinality=1 component such as
// PointLightShadow (plan-strategy D-3). `.detail` carries
// `{ componentName, count, max }` so AI users narrow on `.code` then read
// `.detail` for the offending component name + the bound violated
// (charter P3 progressive disclosure).
//
// `'resource-invalid-value'` sits in the spawn-* fail-fast kebab series
// alongside `'spawn-light-invalid-bounds'` (feat-20260519). Triggered by
// `setTransparentSortConfig(world, { mode, yzAlpha })` when
// `mode ∈/ {0, 1, 2}` (plan-strategy D-4). Generalisable to any future
// world-level resource validator that fails on bound-mismatch payloads;
// `.detail` carries `receivedMode` for the sort-config use case and accepts
// an optional `receivedKey` slot for future resource validators sharing the
// code.
//
// AGENTS.md table sync is deferred to a follow-up w33 (AC-16) so the doc +
// code commits land together with the D-6 historical 23 -> 24 catch-up
// (feat-20260519 missed the table bump). Plan-decisions D-3 + D-4 + D-6
// reference this comment.
// ───────────────────────────────────────────────────────────────────────

/**
 * Thrown / returned via `Result.err` when an attempt is made to add or spawn
 * a second entity with a component declared cardinality = 1 on the World.
 * The canonical first consumer is `PointLightShadow` (at most 4 shadow-casting
 * point lights per scene, cardinality=4); other bounded components route through
 * the same code.
 *
 * `.code = 'cardinality-exceeded'`
 * `.detail = { componentName, count, max }`
 * `.hint` — names the offending component, the current count, and the bound.
 */
export class CardinalityExceededError extends Error {
  override readonly name = 'CardinalityExceededError';
  readonly code = 'cardinality-exceeded' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: {
    readonly componentName: string;
    readonly count: number;
    readonly max: number;
  };

  constructor(componentName: string, count: number, max: number) {
    const hint = `Component "${componentName}" is declared cardinality=${max}; current count ${count} exceeds the bound. Despawn the extra entity or merge the data into a single carrier.`;
    const expectedStr = `count <= ${max} for component "${componentName}"`;
    super(
      `Cardinality exceeded for component "${componentName}".\n` +
        `  code: cardinality-exceeded\n` +
        `  component: ${componentName}\n` +
        `  count: ${count}\n` +
        `  max: ${max}\n` +
        `  expected: ${expectedStr}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = { componentName, count, max };
  }
}

/**
 * Returned via `Result.err` from resource-setter helpers (e.g.
 * `setTransparentSortConfig`) when a numeric payload field violates the
 * closed bound declared by the resource contract. The first consumer is
 * `TransparentSortConfig.mode ∈ {0, 1, 2}` (plan-strategy D-4); future
 * resource validators with the same shape reuse this code by routing
 * through `.detail.receivedKey` to disambiguate which resource validator
 * surfaced the failure.
 *
 * Closed-set kebab code consistent with `spawn-light-invalid-bounds`
 * (feat-20260519 / w2); AI users consume via `switch (err.code)` exhaustive
 * narrows + `err.detail.receivedMode` (or `err.detail.receivedKey` /
 * `err.expected`) property access — never string-parse the message.
 *
 * `.code = 'resource-invalid-value'`
 * `.detail = { receivedMode: number; receivedKey?: string }`
 * `.hint` — direct copy-paste recovery (e.g. "0=layer-z, 1=layer-y,
 *   2=layer-yz" for the sort-config case).
 * `.expected` — the bound contract literal (e.g. "mode ∈ {0, 1, 2}").
 *
 * @reuses RhiError structured shape — same `.code / .expected / .hint /
 *   .detail` quadruple AI users consume across rhi + ecs.
 */
export class ResourceInvalidValueError extends Error {
  override readonly name = 'ResourceInvalidValueError';
  readonly code = 'resource-invalid-value' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail: { readonly receivedMode: number; readonly receivedKey?: string };

  constructor(
    expected: string,
    hint: string,
    detail: { readonly receivedMode: number; readonly receivedKey?: string },
  ) {
    const keyClause = detail.receivedKey === undefined ? '' : `  key: ${detail.receivedKey}\n`;
    super(
      `resource: invalid value.\n` +
        `  code: resource-invalid-value\n` +
        keyClause +
        `  receivedMode: ${detail.receivedMode}\n` +
        `  expected: ${expected}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expected;
    this.detail = detail;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// feat-20260521-sprite-atlas-animation M1 T-05 — closed-union evolution +1.
//
// Adds 1 new member 'sprite-animation-invalid' to EcsErrorCode (25 -> 26).
// AGENTS.md §Error model evolution contract: minor (add member only).
// Same-shape add-only mirror of SpawnLightInvalidBoundsError (feat-20260519
// w2 line 736-776) and ResourceInvalidValueError (feat-20260520 w13 line
// 862) — the kebab `'<noun>-invalid-...'` series keeps `switch (err.code)`
// exhaustive narrows visually consistent (charter P4 consistent abstraction;
// research F-7 candidate A).
//
// Triggered by `spriteAnimationTickSystem` (packages/runtime/src/systems/
// sprite-animation-tick.ts, landed in M4 T-23) when an entity's
// `SpriteAnimation` row violates one of two runtime invariants:
//
//   - field='regions-length' -> `regions.length !== frameCount * 4`
//   - field='frame-duration' -> `frameDuration <= 0`
//
// `.detail.field` two-branch (charter P3: AI users branch once on
// `err.code` and once on `err.detail.field` to reach the recovery hint
// without parsing the message). Plan-strategy section 2 D-1 binds the
// detail field shape; M4 T-19 / T-20 / T-21 cover the runtime fail-fast
// paths end-to-end.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Returned via `Result.err` from `spriteAnimationTickSystem` (M4 T-23) when
 * an entity's `SpriteAnimation` row violates a runtime invariant.
 * Two invariants share one `.code` and discriminate via `.detail.field`:
 *
 * - `regions-length` — `SpriteAnimation.regions.length !== frameCount * 4`.
 *   `regions` packs `[uMin, vMin, uW, vH]` per frame so the length must be
 *   exactly `frameCount * 4`. Detail carries the offending `regionsLength`
 *   alongside the declared `frameCount` so the hint can spell the exact
 *   delta in callsite-friendly numbers.
 * - `frame-duration` — `SpriteAnimation.frameDuration <= 0` (covers both
 *   `frameDuration === 0` and `frameDuration < 0`; T-21 binds the negative
 *   case to the same arm so AI users handle both via a single
 *   `if (err.detail.field === 'frame-duration')` branch — charter P4
 *   consistent abstraction).
 *
 * `.code = 'sprite-animation-invalid'`
 * `.detail = { field: 'regions-length', regionsLength, frameCount } |
 *            { field: 'frame-duration', frameDuration }`
 *
 * Two top-level detail variants give each `.field` branch its own
 * required sub-field shape so AI users get strong narrowing inside
 * `switch (err.detail.field)` without optional sub-fields bleeding
 * across branches (mirrors `SpawnLightInvalidBoundsError`'s shared
 * `got: number` shape but adapted because regions-length /
 * frame-duration carry different sub-field counts).
 *
 * `.hint` — names the offending invariant plus the valid replacement form.
 */
export class SpriteAnimationInvalidError extends Error {
  override readonly name = 'SpriteAnimationInvalidError';
  readonly code = 'sprite-animation-invalid' as const;
  readonly hint: string;
  readonly expected: string;
  readonly detail:
    | {
        readonly field: 'regions-length';
        readonly regionsLength: number;
        readonly frameCount: number;
      }
    | {
        readonly field: 'frame-duration';
        readonly frameDuration: number;
      };

  constructor(
    detail:
      | { field: 'regions-length'; regionsLength: number; frameCount: number }
      | { field: 'frame-duration'; frameDuration: number },
  ) {
    let hint: string;
    let expectedStr: string;
    switch (detail.field) {
      case 'regions-length':
        expectedStr = 'SpriteAnimation.regions.length === frameCount * 4';
        hint = `SpriteAnimation.regions.length = ${detail.regionsLength} does not match frameCount * 4 = ${detail.frameCount * 4}; pack 4 floats [uMin, vMin, uW, vH] per frame (see <name>.atlas.meta.json sidecar 'regions' map)`;
        break;
      case 'frame-duration':
        expectedStr = 'SpriteAnimation.frameDuration > 0';
        hint = `SpriteAnimation.frameDuration = ${detail.frameDuration} is invalid; use a positive seconds-per-frame value (e.g. 0.1 = 10 fps)`;
        break;
    }
    super(
      `SpriteAnimation: invariant violated.\n` +
        `  code: sprite-animation-invalid\n` +
        `  field: ${detail.field}\n` +
        `  expected: ${expectedStr}\n` +
        `  hint: ${hint}`,
    );
    this.hint = hint;
    this.expected = expectedStr;
    this.detail = detail;
  }
}

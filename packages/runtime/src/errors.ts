// @forgeax/engine-runtime — error classes (public surface).
//
// Closed-union RuntimeErrorCode + 8 error classes:
//   - ShadowInvalidConfigError          — DirectionalLight / PointLightShadow field validation (mapSize < 1, cascadeCount ∉ {1..4}, splitLambda ∉ [0,1], cascadeBlend ∉ [0,0.5])
//   - SkinJointCountExceededError       — skin joint count > MAX_JOINTS (256)
//   - SkinJointDespawnedError           — skin joint Entity despawned at extract time
//   - SkinJointPathUnresolvedError      — jointPath Name lookup failed
//   - SkinInstancesCoexistForbiddenError — Skin + Instances on same entity
//   - VertexStorageBufferUnavailableError — device.caps lacks vertex-stage storage buffer
//   - SkinPaletteOverflowError           — palette buffer exceeds device limit
//   - MaterialResolvedEmptyPassesError   — material parent chain resolves to zero passes
//
// Plus pre-existing EngineEnvironmentError ("no usable rendering backend in
// this environment", per K-4 / requirements §AC-06) — callers
// (apps/hello/triangle, t3.6) catch this to render a degradation banner
// (plan-strategy §3 R-1).
//
// feat-20260520-directional-light-shadow-mapping verify round 1: error codes
// were loose strings hand-attached to plain Error objects, violating charter P3
// union-discoverability. This module introduces RuntimeErrorCode as the closed
// union for runtime-layer errors (complementary to EcsErrorCode for ECS errors
// and RhiErrorCode for RHI errors). AI users doing exhaustive switch on
// RuntimeErrorCode get TS exhaustiveness for shadow errors.
//
// feat-20260523-skin-skeleton-animation M1 / T-18: add 6 skin-animation error
// classes (skin-joint-count-exceeded / skin-joint-despawned /
// skin-joint-path-unresolved / skin-instances-coexist-forbidden /
// vertex-storage-buffer-unavailable / skin-palette-overflow).
// M2 will add palette-overflow detail variant.
//
// feat-20260529-material-parent-inheritance-read-through-drop-reso M2 / w5:
// add MaterialResolvedEmptyPassesError (9th RuntimeErrorCode member) for
// material parent chain walk that resolves to zero passes (AC-09,
// plan-strategy D-2/D-3).
//
// feat-20260601-unify-transform-local-global-mat4-drop-globaltrans M4 / w18:
// remove ChildOfWithoutGlobalTransformError + 'child-of-without-global-
// transform' (RuntimeErrorCode 11 -> 10). The world transform now lives on the
// always-present `Transform.world` mat4 column, so a Transform-bearing entity
// can no longer be "ChildOf but missing the world column" -- the entire error
// category is eliminated (charter P3: remove the error class > report it).
//
// feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 / T-M2-04:
// add MeshSsboCapacityExceededError + MeshSsboCeilingReachedError as the 11th
// and 12th members of RuntimeErrorCode (10 -> 12, add-only minor per AGENTS.md
// evolution contract). Both carry the 4-field {code,expected,hint,detail}
// surface aligned with SkinPaletteOverflowError (research §F6.c spiritual
// cousin); detail is { requested, capacity, ceiling } so AI users narrow on
// switch (err.code) without `as` casts (AC-03). The grow factory in
// createRenderer.ts fires through errorRegistry — never throws (D-5).
//
// feat-20260608-cluster-lighting M5 / w20:
// add HdrpCapsInsufficientError + HdrpLightBudgetExceededError +
// HdrpIndexListOverflowError as the 13th, 14th, and 15th members of
// RuntimeErrorCode (12 -> 15, add-only minor). All three carry the
// 4-field {code, expected, hint, detail} surface. caps-insufficient is
// install-time (throw), light-budget-exceeded is per-frame fail-soft
// (once-per-frame fire), index-list-overflow is per-frame fail-soft
// (once-per-frame fire, upgraded from ClusterBinError). detail shapes:
// caps-insufficient = {capName, actual, required};
// light-budget-exceeded = {actual, budget};
// index-list-overflow = {actual, capacity}.

import type { RhiError } from '@forgeax/engine-rhi';

// ── RuntimeErrorCode closed union ─────────────────────────────────────────

/**
 * Closed union of runtime-layer error codes (complementary to EcsErrorCode
 * for ECS-layer errors and RhiErrorCode for RHI-layer errors).
 *
 * Minor add-only per AGENTS.md evolution contract. AI users perform exhaustive
 * `switch (err.code)` without default; TS guards completeness.
 *
 * | code | class | trigger |
 * |:--|:--|:--|
 * | `'shadow-invalid-config'` | `ShadowInvalidConfigError` | `DirectionalLight` shadow fields or `PointLightShadow` validation fail (mapSize<1 / farPlane<=nearPlane) |
 * | `'skin-joint-count-exceeded'` | `SkinJointCountExceededError` | skin joint count exceeds MAX_JOINTS (256) |
 * | `'skin-joint-despawned'` | `SkinJointDespawnedError` | skin joint Entity despawned at extract time |
 * | `'skin-joint-path-unresolved'` | `SkinJointPathUnresolvedError` | jointPath Name lookup failed at post-spawn |
 * | `'skin-instances-coexist-forbidden'` | `SkinInstancesCoexistForbiddenError` | Skin + Instances on same entity |
 * | `'vertex-storage-buffer-unavailable'` | `VertexStorageBufferUnavailableError` | device.caps lacks vertex-stage storage buffer |
 * | `'skin-palette-overflow'` | `SkinPaletteOverflowError` | palette buffer exceeds device maxStorageBufferBindingSize |
 * | `'material-resolved-empty-passes'` | `MaterialResolvedEmptyPassesError` | material parent chain walk resolves to zero passes (missing-parent or no-pass-in-chain) |
 * | `'skybox-cubemap-not-ready'` | `SkyboxCubemapNotReadyError` | cubemap asset not uploaded yet when SkyboxBackground spawns (degrade to clear colour + fire structured error) |
 * | `'mesh-ssbo-capacity-exceeded'` | `MeshSsboCapacityExceededError` | post-grow mesh SSBO capacity still cannot accommodate the requested slot count (defensive fallback under degenerate conditions; frame renders subset) |
 * | `'mesh-ssbo-ceiling-reached'` | `MeshSsboCeilingReachedError` | the requested mesh SSBO slot count would exceed `device.limits.maxStorageBufferBindingSize`; grow refuses to allocate (frame renders subset) |
 * | `'hdrp-caps-insufficient'` | `HdrpCapsInsufficientError` | install-time: `device.caps.maxStorageBuffersPerShaderStage < 4`; HDRP cannot run on this device |
 * | `'hdrp-light-budget-exceeded'` | `HdrpLightBudgetExceededError` | per-frame fail-soft: light count exceeds HDRP budget (256); truncate to 256 |
 * | `'hdrp-index-list-overflow'` | `HdrpIndexListOverflowError` | per-frame fail-soft: cluster binner light index list overflow (>65536); continue rendering |
 * | `'hdrp-deferred-caps-insufficient'` | `HdrpDeferredCapsInsufficientError` | install-time: `device.caps.maxColorAttachments < 4`; deferred path requires 3 g-buffer RT + depth |
 * | `'gbuffer-rt-alloc-failed'` | `GbufferRtAllocFailedError` | runtime: g-buffer color target pool allocation failed (OOM or backend limit) |
 * | `'gbuffer-attachment-count-mismatch'` | `GbufferAttachmentCountMismatchError` | install-time: declared g-buffer attachment count != 3 (internal schema violation) |
 */
export type RuntimeErrorCode =
  | 'shadow-invalid-config'
  | 'skin-joint-count-exceeded'
  | 'skin-joint-despawned'
  | 'skin-joint-path-unresolved'
  | 'skin-instances-coexist-forbidden'
  | 'vertex-storage-buffer-unavailable'
  | 'skin-palette-overflow'
  | 'material-resolved-empty-passes'
  | 'skybox-cubemap-not-ready'
  | 'mesh-ssbo-capacity-exceeded'
  | 'mesh-ssbo-ceiling-reached'
  | 'hdrp-caps-insufficient'
  | 'hdrp-light-budget-exceeded'
  | 'hdrp-index-list-overflow'
  // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-4 (closed-union P3):
  // ShadowAtlas lifecycle / bounds violations — replaces three bare
  // `throw new Error()` sites in shadow-atlas.ts with structured codes that AI
  // users can branch on via `switch (err.code)` without parsing message text.
  | 'point-shadow-atlas-uninitialized'
  | 'point-shadow-atlas-bounds-violation'
  // feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w6:
  // 3 new deferred-path error codes (add-only minor).
  | 'hdrp-deferred-caps-insufficient'
  | 'gbuffer-rt-alloc-failed'
  | 'gbuffer-attachment-count-mismatch'
  // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w17 (D-5):
  // bidirectional Skin <-> pbr-skin material mismatch detected at extract.
  | 'skin-material-mismatch'
  | 'material-skin-attr-missing'
  // feat-20260612-skin-palette-per-frame-upload M2 / m2-5: SkinExtractErrorCode
  // subset union covering the three new fail-fast checks at extractFrame
  // hasSkin time (skeleton handle resolution / SkinAsset.joints.length vs
  // SkeletonAsset.jointCount agreement / per-joint Entity liveness). Single
  // entity continue, sibling entities keep extracting (D-5 pattern).
  | SkinExtractErrorCode;

// ── SkinExtractErrorCode subset union ───────────────────────────────────────

/**
 * feat-20260612-skin-palette-per-frame-upload M2 / m2-5 subset union.
 *
 * Covers the three new fail-fast extract-stage errors that fire from
 * `render-system-extract.ts` `hasSkin` segment when the per-frame palette
 * upload pipeline cannot resolve a slice for an entity. Single-entity
 * `continue` semantics: the entity is skipped, sibling entities in the
 * same frame keep extracting (plan-strategy D-5).
 *
 * | code | class | trigger |
 * |:--|:--|:--|
 * | `'skeleton-resolve-failed'` | `SkeletonResolveFailedError` | `assets.get<SkeletonAsset>(skin.skeleton)` returns null/undefined |
 * | `'joint-count-mismatch'` | `JointCountMismatchError` | `Skin.joints.length !== SkeletonAsset.jointCount` |
 * | `'joint-entity-dangling'` | `JointEntityDanglingError` | `Skin.joints[i]` Entity is despawned (Transform.world view undefined) |
 *
 * AI users discriminate via `switch (err.code)` over `RuntimeErrorCode`;
 * each member narrows to its `*Error` class with structured `.detail`.
 *
 * NOTE: distinct from the pre-existing `'skin-joint-despawned'` /
 * `'skin-joint-path-unresolved'` / `'skin-joint-count-exceeded'`
 * (advanceAnimationPlayer + post-spawn jointPath resolution); plan-strategy
 * D-4 forbids reusing those codes for the new extract-stage triggers.
 */
export type SkinExtractErrorCode =
  | 'skeleton-resolve-failed'
  | 'joint-count-mismatch'
  | 'joint-entity-dangling';

// ── ShadowInvalidConfigError ──────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'shadow-invalid-config'`.
 *
 * Emitted by `DirectionalLight.validate` shadow-field path when a field value violates
 * runtime constraints (e.g. mapSize < 1, cascadeCount not in {1..4}).
 * AI users access `.detail.field` / `.detail.value` / `.detail.min` /
 * `.detail.max` via property access — no string parsing.
 *
 * `max` is `undefined` for lower-bound-only validations (e.g. mapSize < 1).
 * feat-20260613-csm: max added for upper-bound cascade validations
 * (cascadeCount max=4, splitLambda max=1, cascadeBlend max=0.5).
 */
export interface ShadowInvalidConfigDetail {
  readonly field: string;
  readonly value: number;
  readonly min: number;
  readonly max?: number;
}

/**
 * Structured error for shadow component config validation failures.
 *
 * Emitted by `DirectionalLight.validate()` shadow-field path (mapSize / cascadeCount /
 * splitLambda / cascadeBlend / farPlane) and `PointLightShadow.validate()`
 * (mapSize / farPlane > nearPlane / pcfKernelSize); both shadow component
 * types share this single error class so `switch (err.code)` on
 * `RuntimeErrorCode` only needs one branch (charter P4 — closed-union SSOT).
 * Four-field surface per AGENTS.md error model:
 *   - `.code = 'shadow-invalid-config'` (closed RuntimeErrorCode)
 *   - `.expected` — expected-state description (programmatic predicate form)
 *   - `.hint` — actionable recovery guidance (imperative; AI users paste into
 *     spawn calls). Integer-typed fields (e.g. `cascadeCount`, `pcfKernelSize`)
 *     get an "integer in [min, max]" hint; otherwise "[min, max]" range or
 *     "<comparator> min".
 *   - `.detail = { field, value, min, max? }` — structured values (charter P4)
 *
 * 4th constructor parameter is a union over the two range shapes:
 *   - `number` — `max` for a closed `[min, max]` range (CSM cascadeCount /
 *     splitLambda / cascadeBlend). hint uses "in [min, max]"; integer-typed
 *     fields get "integer in [min, max]".
 *   - `'>' | '>='` — comparator for an open lower-bound predicate. `'>'` is
 *     used when `min` carries dynamic context (e.g. `farPlane > nearPlane` —
 *     the surfaced hint reads "must be > nearPlane" so AI users setting
 *     farPlane=nearPlane don't re-fail the spawn loop with the wrong cue).
 *   - `undefined` — defaults to `'>='`. Callsites for mapSize < 1 validation
 *     stay backward-compatible (3-arg form).
 */
export class ShadowInvalidConfigError extends Error {
  readonly code = 'shadow-invalid-config' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: ShadowInvalidConfigDetail;

  constructor(field: string, value: number, min: number, maxOrComparator?: number | '>' | '>=') {
    const isComparator = maxOrComparator === '>' || maxOrComparator === '>=';
    const max = !isComparator && typeof maxOrComparator === 'number' ? maxOrComparator : undefined;
    const comparator: '>' | '>=' = isComparator ? (maxOrComparator as '>' | '>=') : '>=';
    // Integer-typed fields get an "integer in [min, max]" hint when a range
    // is supplied. Expand this set as new integer-typed shadow fields land.
    const isInteger = field === 'cascadeCount' || field === 'pcfKernelSize';
    // pcfKernelSize must be odd (kernel is symmetric around the center tap).
    // Naming "odd" in the hint stops an AI retry from looping min->min+1 (4->6).
    const isOdd = field === 'pcfKernelSize';
    const hint =
      max !== undefined
        ? isInteger
          ? `set ${field} to an integer in [${min}, ${max}]; got ${value}`
          : `set ${field} to a value in [${min}, ${max}]; got ${value}`
        : isOdd
          ? `set ${field} to an odd integer ${comparator} ${min}; got ${value}`
          : `set ${field} to a value ${comparator} ${min}; got ${value}`;
    const expected =
      max !== undefined ? `${field} in [${min}, ${max}]` : `${field} ${comparator} ${min}`;
    super(
      max !== undefined
        ? `shadow component .${field} must be in [${min}, ${max}], got ${value}`
        : `shadow component .${field} must be ${comparator} ${min}, got ${value}`,
    );
    this.name = 'ShadowInvalidConfigError';
    this.hint = hint;
    this.expected = expected;
    this.detail = { field, value, min, ...(max !== undefined ? { max } : {}) };
  }
}

// ── SkinJointCountExceededError ────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skin-joint-count-exceeded'`.
 *
 * Emitted when a glTF skin has more than MAX_JOINTS (256) joints.
 */
export interface SkinJointCountExceededDetail {
  readonly jointCount: number;
  readonly max: number;
}

/**
 * Structured error for skin joint count exceeding the engine cap.
 *
 * Emitted during skin import/validation. Four-field surface:
 *   - `.code = 'skin-joint-count-exceeded'`
 *   - `.expected` — max allowed (256)
 *   - `.hint` — reduce joint count in the source asset
 *   - `.detail = { jointCount, max }` — actual vs limit
 */
export class SkinJointCountExceededError extends Error {
  readonly code = 'skin-joint-count-exceeded' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinJointCountExceededDetail;

  constructor(jointCount: number, max = 256) {
    const expected = `jointCount <= ${max}`;
    const hint = `skin has ${jointCount} joints (max ${max}); reduce joint count in the source glTF asset (OOS-skin-many-joints)`;
    super(`skin joint count ${jointCount} exceeds max ${max}`);
    this.name = 'SkinJointCountExceededError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { jointCount, max };
  }
}

// ── SkinJointDespawnedError ─────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skin-joint-despawned'`.
 *
 * Emitted at extract time when a Skin.joints[i] Entity has been despawned.
 */
export interface SkinJointDespawnedDetail {
  readonly meshEntity: number;
  readonly jointIndex: number;
}

/**
 * Structured error for despawned skin joint Entity.
 *
 * Emitted at extract time; the mesh draw is fully skipped.
 *   - `.code = 'skin-joint-despawned'`
 *   - `.expected` — all Skin.joints alive
 *   - `.hint` — remove the Skin component or re-spawn joints
 *   - `.detail = { meshEntity, jointIndex }`
 */
export class SkinJointDespawnedError extends Error {
  readonly code = 'skin-joint-despawned' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinJointDespawnedDetail;

  constructor(meshEntity: number, jointIndex: number) {
    const expected = `Skin.joints[${jointIndex}] references a live entity`;
    const hint = `joint[${jointIndex}] of entity ${meshEntity} has been despawned; remove Skin component or re-spawn the joint entity (OOS-skin-joint-respawn)`;
    super(`skin joint[${jointIndex}] despawned for entity ${meshEntity}`);
    this.name = 'SkinJointDespawnedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { meshEntity, jointIndex };
  }
}

// ── SkinJointPathUnresolvedError ────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skin-joint-path-unresolved'`.
 *
 * Emitted at post-spawn time when a jointPath leaf name cannot be found.
 */
export interface SkinJointPathUnresolvedDetail {
  readonly skinEntity: number;
  readonly path: readonly string[];
  readonly failedAtIndex: number;
}

/**
 * Structured error for unresolved jointPath post-spawn.
 *
 * Emitted by postSpawnResolveJoints when Name lookup fails.
 *   - `.code = 'skin-joint-path-unresolved'`
 *   - `.expected` — Name-bearing entity exists for each jointPath leaf
 *   - `.hint` — verify glTF node Name preservation in the importer
 *   - `.detail = { skinEntity, path, failedAtIndex }`
 */
export class SkinJointPathUnresolvedError extends Error {
  readonly code = 'skin-joint-path-unresolved' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinJointPathUnresolvedDetail;

  constructor(skinEntity: number, path: readonly string[], failedAtIndex: number) {
    const leafName = path[failedAtIndex] ?? '<unknown>';
    const expected = `joint entity with Name="${leafName}" exists in the world`;
    const hint = `joint path "${path.join('/')}" for skin entity ${skinEntity} could not be resolved; verify glTF node names are preserved`;
    super(
      `joint path "${path.join('/')}" unresolved at index ${failedAtIndex} for entity ${skinEntity}`,
    );
    this.name = 'SkinJointPathUnresolvedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { skinEntity, path, failedAtIndex };
  }
}

// ── SkinInstancesCoexistForbiddenError ──────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skin-instances-coexist-forbidden'`.
 *
 * Emitted at extract time when Skin + Instances coexist on the same entity.
 */
export interface SkinInstancesCoexistForbiddenDetail {
  readonly entity: number;
}

/**
 * Structured error for Skin + Instances coexistence on same entity.
 *
 * Emitted at extract time; the entity draw is skipped.
 *   - `.code = 'skin-instances-coexist-forbidden'`
 *   - `.expected` — Skin and Instances on separate entities
 *   - `.hint` — split skinned meshes from instanced meshes into separate entities (OOS-skin-instances-coexist)
 *   - `.detail = { entity }`
 */
export class SkinInstancesCoexistForbiddenError extends Error {
  readonly code = 'skin-instances-coexist-forbidden' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinInstancesCoexistForbiddenDetail;

  constructor(entity: number) {
    const expected = 'Skin and Instances must not coexist on the same entity';
    const hint = `entity ${entity} has both Skin and Instances; split skinned meshes from instanced meshes into separate entities (OOS-skin-instances-coexist)`;
    super(`Skin + Instances coexistence forbidden on entity ${entity}`);
    this.name = 'SkinInstancesCoexistForbiddenError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { entity };
  }
}

// ── VertexStorageBufferUnavailableError ─────────────────────────────────

/**
 * Structured error for missing vertex-stage storage buffer capability.
 *
 * Emitted at createRenderer time (cap-gate).
 *   - `.code = 'vertex-storage-buffer-unavailable'`
 *   - `.expected` — device.caps supports vertex-stage storage buffer
 *   - `.hint` — switch to a WebGPU adapter with vertex storage buffer support or use uniform-buffer fallback (OOS-uniform-palette)
 *   - `.detail` — undefined (no narrowed detail variant)
 */
export class VertexStorageBufferUnavailableError extends Error {
  readonly code = 'vertex-storage-buffer-unavailable' as const;
  readonly expected: string;
  readonly hint: string;

  constructor() {
    const expected =
      'device.caps supports vertex-stage storage buffer (maxStorageBuffersPerShaderStage >= 1)';
    const hint =
      'this device does not support vertex-stage storage buffers; skinning requires vertex-stage storage buffer access (OOS-uniform-palette fallback not implemented)';
    super('vertex-stage storage buffer unavailable — skinning cannot operate');
    this.name = 'VertexStorageBufferUnavailableError';
    this.expected = expected;
    this.hint = hint;
  }
}

// ── SkinPaletteOverflowError ────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skin-palette-overflow'`.
 *
 * Emitted at extract time when the palette allocation exceeds
 * device.limits.maxStorageBufferBindingSize.
 */
export interface SkinPaletteOverflowDetail {
  readonly requestedBytes: number;
  readonly limit: number;
}

/**
 * Structured error for palette buffer exceeding device limit.
 *
 * Emitted at extract time when the joint palette allocation overflows
 * device.limits.maxStorageBufferBindingSize.
 *   - `.code = 'skin-palette-overflow'`
 *   - `.expected` — palette buffer fits in maxStorageBufferBindingSize
 *   - `.hint` — reduce skinned entity count or split into multiple palette buffers (OOS-skin-palette-batch)
 *   - `.detail = { requestedBytes, limit }` — M2 detailed variant
 */
export class SkinPaletteOverflowError extends Error {
  readonly code = 'skin-palette-overflow' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinPaletteOverflowDetail;

  constructor(requestedBytes: number, limit: number) {
    const expected = `skinned joint palette (${requestedBytes} B) fits within device.limits.maxStorageBufferBindingSize (${limit} B)`;
    const hint =
      'palette buffer exceeds device maxStorageBufferBindingSize; reduce skinned entity count or split into multiple palette buffers (OOS-skin-palette-batch)';
    super(`skin palette buffer needs ${requestedBytes} B, exceeds device limit ${limit} B`);
    this.name = 'SkinPaletteOverflowError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { requestedBytes, limit };
  }
}

// ── MaterialResolvedEmptyPassesError ──────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'material-resolved-empty-passes'`.
 *
 * Emitted at material parent chain walk time when the resolved passes list
 * is empty. Two reasons: `'missing-parent'` (a parent handle is not
 * registered) and `'no-pass-in-chain'` (the entire parent chain has no
 * pass declarations). AI users switch on `.detail.reason` to surface the
 * right recovery guidance.
 *
 * plan-strategy D-2/D-3: empty-passes is a runtime-layer error
 * (RuntimeErrorCode, not AssetErrorCode).
 */
export interface MaterialResolvedEmptyPassesDetail {
  /** GUID of the material whose resolve produced empty passes. */
  readonly materialGuid: string;
  /** Root cause of the empty passes: missing parent vs entire chain has no passes. */
  readonly reason: 'missing-parent' | 'no-pass-in-chain';
  /** The raw numeric handle id of the unregistered parent. Only populated when reason='missing-parent'. */
  readonly missingParentHandle?: number;
}

/**
 * Structured error for material parent chain resolve yielding zero passes.
 *
 * Emitted by `AssetRegistry.passesOf` when the parent chain walk produces
 * an empty passes list (AC-09, D-3 two-reason). Four-field surface:
 *   - `.code = 'material-resolved-empty-passes'` (closed RuntimeErrorCode)
 *   - `.expected` — expected-state description
 *   - `.hint` — actionable recovery guidance (differs per reason)
 *   - `.detail = { materialGuid, reason, missingParentHandle? }`
 */
export class MaterialResolvedEmptyPassesError extends Error {
  readonly code = 'material-resolved-empty-passes' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MaterialResolvedEmptyPassesDetail;

  constructor(
    materialGuid: string,
    reason: 'missing-parent' | 'no-pass-in-chain',
    missingParentHandle?: number,
  ) {
    const expected =
      reason === 'missing-parent'
        ? `parent handle ${missingParentHandle} present in AssetRegistry`
        : 'at least one material in the parent chain declares passes';
    const hint =
      reason === 'missing-parent'
        ? `material ${materialGuid} references parent handle ${missingParentHandle} which is not registered; register the parent first or check handle spelling`
        : `material ${materialGuid} has no passes and its entire parent chain also has no pass declarations; add pass declarations to at least one chain member`;
    const message =
      reason === 'missing-parent'
        ? `material ${materialGuid} parent handle ${missingParentHandle} not registered`
        : `material ${materialGuid} parent chain resolves to zero passes`;

    super(message);
    this.name = 'MaterialResolvedEmptyPassesError';
    this.expected = expected;
    this.hint = hint;
    this.detail = {
      materialGuid,
      reason,
      ...(reason === 'missing-parent' && missingParentHandle !== undefined
        ? { missingParentHandle }
        : {}),
    };
  }
}

// ── SkyboxCubemapNotReadyError ───────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skybox-cubemap-not-ready'`.
 *
 * Emitted when a `SkyboxBackground` component references a cubemap handle
 * whose GPU resources have not been uploaded yet. The handle id is carried
 * so AI users can trace which asset registration failed. Degradation:
 * `skyboxActive = false` -> main pass `loadOp='clear'` -> clear colour
 * background (no skybox visible, but no black/corrupt screen either).
 *
 * plan-strategy D-8: structured error with detail carrying the handle id.
 */
export interface SkyboxCubemapNotReadyDetail {
  readonly handle: number;
}

/**
 * Structured error for SkyboxBackground cubemap not yet uploaded.
 *
 * Emitted by the record stage when getCubemapGpuView returns undefined for the
 * handle referenced by the SkyboxBackground ECS component. Four-field surface
 * per AGENTS.md error model:
 *   - `.code = 'skybox-cubemap-not-ready'` (closed RuntimeErrorCode)
 *   - `.expected` — cubemap asset uploaded and GPU view available
 *   - `.hint` — await `uploadCubemapFromEquirect()` or verify the handle
 *     references a registered CubeTextureAsset
 *   - `.detail = { handle }` — the numeric handle id for diagnostics
 */
export class SkyboxCubemapNotReadyError extends Error {
  readonly code = 'skybox-cubemap-not-ready' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkyboxCubemapNotReadyDetail;

  constructor(handle: number) {
    const expected = `cubemap handle ${handle} has an uploaded GPU cubemap view`;
    const hint =
      `cubemap handle ${handle} referenced by SkyboxBackground is not ready; ` +
      `await uploadCubemapFromEquirect() before rendering, or verify the handle references an already-registered CubeTextureAsset`;
    super(`SkyboxBackground cubemap handle ${handle} GPU view not ready`);
    this.name = 'SkyboxCubemapNotReadyError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { handle };
  }
}

// ── MeshSsboCapacityExceededError ────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'mesh-ssbo-capacity-exceeded'`.
 *
 * Fired by `growMeshSsbo` (createRenderer.ts grow factory) when, after
 * attempting pow2 doubling, the resulting `slotCount` still cannot
 * accommodate the requested `requested` slot count under the device's
 * `maxStorageBufferBindingSize` ceiling. This is a defensive fallback —
 * the primary path for "request past device limit" is
 * `mesh-ssbo-ceiling-reached`. The two codes share the same detail shape so
 * AI users handle both arms identically; the discriminant identifies which
 * branch fired so diagnostics can distinguish the primary vs defensive
 * surface (research §F6.c).
 *
 *   - `requested` — slot count requested by the caller (entity count for the frame)
 *   - `capacity`  — current `slotCount` in the grow controller's state
 *   - `ceiling`   — `device.limits.maxStorageBufferBindingSize` in BYTES (not slots)
 */
export interface MeshSsboCapacityExceededDetail {
  readonly requested: number;
  readonly capacity: number;
  readonly ceiling: number;
}

/**
 * Structured error for the post-grow defensive fallback when mesh-SSBO
 * capacity cannot accommodate the requested slot count.
 *
 * Emitted by `growMeshSsbo` in `createRenderer.ts` (D-5: fire, never
 * throw). Four-field surface aligned with `SkinPaletteOverflowError`:
 *   - `.code = 'mesh-ssbo-capacity-exceeded'`
 *   - `.expected` — capacity >= requested
 *   - `.hint` — reduce per-frame entity count or split work across frames
 *   - `.detail = { requested, capacity, ceiling }`
 */
export class MeshSsboCapacityExceededError extends Error {
  readonly code = 'mesh-ssbo-capacity-exceeded' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MeshSsboCapacityExceededDetail;

  constructor(requested: number, capacity: number, ceiling: number) {
    const expected = `mesh SSBO slotCount >= ${requested} (currently ${capacity}; device ceiling ${ceiling} B)`;
    const hint =
      `mesh SSBO grow could not satisfy needed=${requested} slots (capacity=${capacity}, ceiling=${ceiling} B); ` +
      'reduce per-frame entity count or split work across frames (defensive fallback path)';
    super(
      `mesh SSBO capacity exceeded: needed ${requested} slots, capacity ${capacity}, ceiling ${ceiling} B`,
    );
    this.name = 'MeshSsboCapacityExceededError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { requested, capacity, ceiling };
  }
}

// ── MeshSsboCeilingReachedError ──────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'mesh-ssbo-ceiling-reached'`.
 *
 * Fired by `growMeshSsbo` when the requested slot count would exceed the
 * device's `maxStorageBufferBindingSize` (the only ceiling per D-1; engine
 * carries no private capacity constant). Same detail shape as
 * `MeshSsboCapacityExceededDetail`.
 *
 *   - `requested` — slot count requested by the caller
 *   - `capacity`  — current `slotCount` in the grow controller's state
 *   - `ceiling`   — `device.limits.maxStorageBufferBindingSize` in BYTES
 */
export interface MeshSsboCeilingReachedDetail {
  readonly requested: number;
  readonly capacity: number;
  readonly ceiling: number;
}

/**
 * Structured error for mesh-SSBO grow refused because the request exceeds
 * `device.limits.maxStorageBufferBindingSize`.
 *
 * Emitted by `growMeshSsbo` (D-5: fire, never throw). The frame renders a
 * degraded subset (truncated to pre-grow capacity) per plan-strategy D-2 —
 * no black frame. Four-field surface aligned with `SkinPaletteOverflowError`:
 *   - `.code = 'mesh-ssbo-ceiling-reached'`
 *   - `.expected` — requested * stride <= device.limits.maxStorageBufferBindingSize
 *   - `.hint` — reduce per-frame entity count or pick a higher-tier adapter
 *   - `.detail = { requested, capacity, ceiling }`
 */
export class MeshSsboCeilingReachedError extends Error {
  readonly code = 'mesh-ssbo-ceiling-reached' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MeshSsboCeilingReachedDetail;

  constructor(requested: number, capacity: number, ceiling: number) {
    const expected = `mesh SSBO slot byte size <= device.limits.maxStorageBufferBindingSize (${ceiling} B)`;
    const hint =
      `requested ${requested} mesh SSBO slots would exceed device.limits.maxStorageBufferBindingSize (${ceiling} B); ` +
      'reduce per-frame entity count or run on an adapter with a larger storage buffer binding size';
    super(
      `mesh SSBO ceiling reached: needed ${requested} slots; capacity ${capacity}; ceiling ${ceiling} B`,
    );
    this.name = 'MeshSsboCeilingReachedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { requested, capacity, ceiling };
  }
}

// ── HdrpCapsInsufficientError ──────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'hdrp-caps-insufficient'`.
 *
 * Emitted at install time when `device.caps.maxStorageBuffersPerShaderStage < 4`.
 */
export interface HdrpCapsInsufficientDetail {
  readonly capName: string;
  readonly actual: number;
  readonly required: number;
}

/**
 * Structured error for HDRP storage-buffer capability gate failure (AC-17/AC-18).
 *
 * Emitted at `installPipeline(hdrpAsset)` time — synchronous throw.
 *   - `.code = 'hdrp-caps-insufficient'` (closed RuntimeErrorCode)
 *   - `.expected` — describes the required capability
 *   - `.hint` — 'fall back to URP by not calling installPipeline'
 *   - `.detail = { capName, actual, required }`
 */
export class HdrpCapsInsufficientError extends Error {
  readonly code = 'hdrp-caps-insufficient' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: HdrpCapsInsufficientDetail;

  constructor(capName: string, actual: number, required: number) {
    const expected = `${capName} >= ${required}`;
    const hint =
      `${capName} = ${actual} (need >= ${required}); ` +
      'this device does not have enough storage buffer slots for HDRP cluster-forward rendering. ' +
      'Fall back to URP by not calling installPipeline(hdrpAsset)';
    super(`HDRP caps insufficient: ${capName} = ${actual} (need >= ${required})`);
    this.name = 'HdrpCapsInsufficientError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { capName, actual, required };
  }
}

// ── HdrpLightBudgetExceededError ───────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'hdrp-light-budget-exceeded'`.
 *
 * Emitted per-frame (once-per-frame fire) when light count exceeds HDRP budget.
 */
export interface HdrpLightBudgetExceededDetail {
  readonly actual: number;
  readonly budget: number;
}

/**
 * Structured error for HDRP light budget exceeded (AC-06/AC-07).
 *
 * Emitted per-frame in recordFrame when the total punctual light count
 * exceeds the HDRP budget (256). Fail-soft: fire once per frame, truncate to 256.
 *   - `.code = 'hdrp-light-budget-exceeded'` (closed RuntimeErrorCode)
 *   - `.expected` — 'light count <= 256'
 *   - `.hint` — 'reduce world light count or increase budget (OOS-hdrp-larger-budget)'
 *   - `.detail = { actual, budget }`
 */
export class HdrpLightBudgetExceededError extends Error {
  readonly code = 'hdrp-light-budget-exceeded' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: HdrpLightBudgetExceededDetail;

  constructor(actual: number, budget: number) {
    const expected = `light count <= ${budget}`;
    const hint =
      `${actual} lights exceed HDRP budget ${budget}; ` +
      'truncating to 256. Reduce light count or wait for OOS-hdrp-larger-budget';
    super(`HDRP light budget exceeded: ${actual} > ${budget}`);
    this.name = 'HdrpLightBudgetExceededError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { actual, budget };
  }
}

// ── HdrpIndexListOverflowError ─────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'hdrp-index-list-overflow'`.
 *
 * Emitted per-frame (once-per-frame fire) when the cluster binner overflows
 * the light index list capacity (65536). Upgraded from ClusterBinError.
 */
export interface HdrpIndexListOverflowDetail {
  readonly actual: number;
  readonly capacity: number;
}

/**
 * Structured error for HDRP cluster binner index list overflow (AC-24).
 *
 * Emitted per-frame in recordFrame when the CPU binner returns
 * `ClusterBinError('index-overflow')`. Fail-soft: fire once per frame,
 * continue rendering with what fit.
 *   - `.code = 'hdrp-index-list-overflow'` (closed RuntimeErrorCode)
 *   - `.expected` — 'light index list entries <= 65536'
 *   - `.hint` — 'reduce lights, shrink cluster grid, or increase capacity'
 *   - `.detail = { actual, capacity }`
 */
export class HdrpIndexListOverflowError extends Error {
  readonly code = 'hdrp-index-list-overflow' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: HdrpIndexListOverflowDetail;

  constructor(actual: number, capacity: number) {
    const expected = `light index list entries <= ${capacity}`;
    const hint =
      `cluster binner overflow: writeCount ${actual} exceeds capacity ${capacity}; ` +
      'reduce lights, shrink cluster grid, or increase LIGHT_INDEX_LIST_CAPACITY';
    super(`HDRP index list overflow: ${actual} > ${capacity}`);
    this.name = 'HdrpIndexListOverflowError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { actual, capacity };
  }
}

// ── HdrpDeferredCapsInsufficientError ──────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'hdrp-deferred-caps-insufficient'`.
 *
 * Emitted at `installPipeline(hdrpAsset)` time when `device.caps.maxColorAttachments < 4`,
 * meaning the deferred path cannot allocate 3 g-buffer color targets + depth.
 */
export interface HdrpDeferredCapsInsufficientDetail {
  readonly actual: number;
  readonly expected: number;
}

/**
 * Structured error for deferred-path capability gate failure.
 *
 * Emitted at `installPipeline(hdrpAsset)` time — synchronous throw.
 *   - `.code = 'hdrp-deferred-caps-insufficient'` (closed RuntimeErrorCode)
 *   - `.expected` — 'maxColorAttachments >= 4'
 *   - `.hint` — actionable guidance to upgrade browser or select URP
 *   - `.detail = { actual, expected }`
 *
 * @see plan-strategy D-5 (install-time caps check, no silent fallback)
 */
export class HdrpDeferredCapsInsufficientError extends Error {
  readonly code = 'hdrp-deferred-caps-insufficient' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: HdrpDeferredCapsInsufficientDetail;

  constructor(actual: number) {
    const _expected = 4;
    const _expectedStr = `maxColorAttachments >= ${_expected}`;
    const hint =
      `WebGPU maxColorAttachments = ${actual} (need >= ${_expected}). ` +
      'Upgrade browser to latest Chrome/Edge/Safari, or use URP (forgeax::urp) instead of HDRP.';
    super(
      `HDRP deferred caps insufficient: maxColorAttachments = ${actual} (need >= ${_expected})`,
    );
    this.name = 'HdrpDeferredCapsInsufficientError';
    this.expected = _expectedStr;
    this.hint = hint;
    this.detail = { actual, expected: _expected };
  }
}

// ── GbufferRtAllocFailedError ──────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'gbuffer-rt-alloc-failed'`.
 *
 * Emitted at runtime when a g-buffer color target pool allocation fails
 * (OOM or backend resource limit). The attachmentIndex identifies which
 * g-buffer slot failed.
 */
export interface GbufferRtAllocFailedDetail {
  readonly attachmentIndex: number;
  readonly requestedBytes: number;
}

/**
 * Structured error for g-buffer color-target pool allocation failure.
 *
 * Emitted at runtime during g-buffer pass setup.
 *   - `.code = 'gbuffer-rt-alloc-failed'` (closed RuntimeErrorCode)
 *   - `.expected` — 'g-buffer color target allocation succeeded'
 *   - `.hint` — actionable recovery steps (check GPU memory / reduce resolution)
 *   - `.detail = { attachmentIndex, requestedBytes }`
 *
 * @note This error is declared in M1 but only triggered in M2 (g-buffer RT
 *   allocation path). The union member exists for compile-time narrowing now.
 */
export class GbufferRtAllocFailedError extends Error {
  readonly code = 'gbuffer-rt-alloc-failed' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: GbufferRtAllocFailedDetail;

  constructor(attachmentIndex: number, requestedBytes: number) {
    const expected = 'g-buffer color target allocation succeeded';
    const hint =
      `g-buffer color target (attachment ${attachmentIndex}, ${requestedBytes} bytes) allocation failed. ` +
      'Common causes: (a) GPU memory pressure; (b) framebuffer resolution too large; ' +
      '(c) RHI backend limits hit. Check device.limits and reduce frame resolution.';
    super(`g-buffer RT alloc failed: attachment[${attachmentIndex}] = ${requestedBytes} bytes`);
    this.name = 'GbufferRtAllocFailedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { attachmentIndex, requestedBytes };
  }
}

// ── GbufferAttachmentCountMismatchError ────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'gbuffer-attachment-count-mismatch'`.
 *
 * Emitted at install-time when the g-buffer attachment count declared
 * in the pipeline schema does not equal 3.
 */
export interface GbufferAttachmentCountMismatchDetail {
  readonly actual: number;
  readonly expected: number;
}

/**
 * Structured error for g-buffer attachment count mismatch.
 *
 * Emitted at `installPipeline(hdrpAsset)` time via topology validation.
 *   - `.code = 'gbuffer-attachment-count-mismatch'` (closed RuntimeErrorCode)
 *   - `.expected` — 'exactly 3 g-buffer color attachments'
 *   - `.hint` — check pipeline internal schema or custom g-buffer override
 *   - `.detail = { actual, expected }`
 *
 * @note This error is declared in M1 but only triggered in M2 (g-buffer
 *   topology validation). The union member exists for compile-time narrowing now.
 */
export class GbufferAttachmentCountMismatchError extends Error {
  readonly code = 'gbuffer-attachment-count-mismatch' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: GbufferAttachmentCountMismatchDetail;

  constructor(actual: number) {
    const _expected = 3;
    const _expectedStr = `exactly ${_expected} g-buffer color attachments`;
    const hint =
      `HDRP deferred expects ${_expected} g-buffer color attachments, got ${actual}. ` +
      'Check hdrp-pipeline internal schema or custom g-buffer override.';
    super(`g-buffer attachment count mismatch: got ${actual}, expected ${_expected}`);
    this.name = 'GbufferAttachmentCountMismatchError';
    this.expected = _expectedStr;
    this.hint = hint;
    this.detail = { actual, expected: _expected };
  }
}

// ── RuntimeError union ───────────────────────────────────────────────────────

/**
 * Closed union of the structured runtime-layer error classes, each carrying a
 * `RuntimeErrorCode` discriminant on `.code`. Complements `RhiError` (RHI
 * layer) so the `Renderer.onError` channel can fan out both error families
 * through a single listener while preserving exhaustive `switch (err.code)`
 * narrowing.
 *
 * `EngineEnvironmentError` is intentionally excluded: it is thrown at
 * construction time (`createRenderer` rejects), never fanned out through
 * `onError`. The members below are the runtime classes that actually fire
 * through `RhiErrorListenerRegistry` per the `Renderer` error-tier table.
 *
 * AI users widen their listener to `RhiError | RuntimeError` and switch on
 * `.code`: the disjoint `RhiErrorCode` / `RuntimeErrorCode` literal sets let
 * TS narrow each arm to the concrete class (charter P3 union discoverability +
 * P4 explicit failure).
 */
export type RuntimeError =
  | ShadowInvalidConfigError
  | SkinJointCountExceededError
  | SkinJointDespawnedError
  | SkinJointPathUnresolvedError
  | SkinInstancesCoexistForbiddenError
  | VertexStorageBufferUnavailableError
  | SkinPaletteOverflowError
  | MaterialResolvedEmptyPassesError
  | SkyboxCubemapNotReadyError
  | MeshSsboCapacityExceededError
  | MeshSsboCeilingReachedError
  | HdrpCapsInsufficientError
  | HdrpLightBudgetExceededError
  | HdrpIndexListOverflowError
  | HdrpDeferredCapsInsufficientError
  | GbufferRtAllocFailedError
  | GbufferAttachmentCountMismatchError
  // feat-20260611-fox-skinning-vertex-attribute-chain M4 / w17 (D-5):
  | SkinMaterialMismatchError
  | MaterialSkinAttrMissingError
  // feat-20260612-skin-palette-per-frame-upload M2 / m2-5: SkinExtractErrorCode
  // subset union (3 new extract-stage fail-fast classes).
  | SkeletonResolveFailedError
  | JointCountMismatchError
  | JointEntityDanglingError
  // feat-20260612-point-light-shadows-urp-hdrp Round-2 F-4: ShadowAtlas P3.
  | PointShadowAtlasUninitializedError
  | PointShadowAtlasBoundsViolationError;

/**
 * Structured signal carrier for the `EngineEnvironmentError.detail` field.
 *
 * When the WebGPU probe fails via an RHI Result.err, the original `RhiError`
 * structured object is preserved directly as `webgpuError` — AI consumers can
 * read `.code` / `.expected` / `.hint` by property access.
 *
 * w20 / M4: at least one field (webgpuError or wgpuError) is always populated
 * when an EngineEnvironmentError is thrown. The detail object is never empty.
 * AI users can safely do `switch (e.detail.webgpuError?.code)` knowing that
 * at least one branch will match.
 */
export interface EngineEnvironmentErrorDetail {
  /** WebGPU-path RhiError structured object (with .code / .expected / .hint / .detail); falls back to a plain Error on non-RHI paths. */
  readonly webgpuError?: RhiError | Error | undefined;
  /**
   * Channel 3 fallback error (rhi-wgpu dynamic import + wasm load failure).
   * Populated when Channel 2 fails AND the Channel 3 retry also fails.
   * AI users exhaustively `switch (e.detail.wgpuError?.code)` to understand
   * why both channels are unavailable.
   */
  readonly wgpuError?: RhiError | Error | undefined;
}

/**
 * Thrown by `createRenderer` when no usable rendering backend can be acquired.
 * The probe failure is recorded so callers can surface it for diagnostics.
 *
 * AI consumers access `.detail.webgpuError.code` etc. by property (charter
 * proposition 4 explicit failure + proposition 5 consistent abstraction).
 */
export class EngineEnvironmentError extends Error {
  /** Brief reason describing why no backend was usable. */
  readonly reason: string;
  /** WebGPU-side probe error: `RhiError` (three fields + closed union) or plain `Error`. */
  readonly webgpuError?: RhiError | Error | undefined;
  /**
   * Channel 3 (rhi-wgpu) fallback error.
   * Populated when both Channel 2 and the Channel 3 retry fail.
   */
  readonly wgpuError?: RhiError | Error | undefined;
  /** Structured detail container: AI consumers access `.detail.webgpuError?.code` for safe chained access. */
  readonly detail: EngineEnvironmentErrorDetail;

  constructor(reason: string, detail?: EngineEnvironmentErrorDetail) {
    super(`forgeax-engine: no usable backend (${reason})`);
    this.name = 'EngineEnvironmentError';
    this.reason = reason;
    const webgpuError = detail?.webgpuError;
    if (webgpuError !== undefined) {
      this.webgpuError = webgpuError;
    }
    const wgpuError = detail?.wgpuError;
    if (wgpuError !== undefined) {
      this.wgpuError = wgpuError;
    }
    this.detail = {
      ...(webgpuError !== undefined ? { webgpuError } : {}),
      ...(wgpuError !== undefined ? { wgpuError } : {}),
    };
  }
}

// ── SkinMaterialMismatchError ─────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skin-material-mismatch'`.
 *
 * Emitted at extract time when an entity carries a `Skin` component but
 * its resolved `MaterialAsset.passes[0].shader !== 'forgeax::pbr-skin'`.
 * `actualShader` carries the resolved shader id (or `undefined` when the
 * material has no passes) so AI consumers can branch on the precise mismatch
 * (e.g. unlit / pbr / sprite) without parsing prose.
 */
export interface SkinMaterialMismatchDetail {
  readonly entity: number;
  readonly actualShader: string | undefined;
}

/**
 * Structured error for the Skin -> non-pbr-skin material direction
 * (feat-20260611-fox-skinning-vertex-attribute-chain M4 / w17 / D-5).
 *
 * Emitted at extract time; the entity draw is skipped (continue), other
 * entities in the same frame keep rendering.
 *   - `.code = 'skin-material-mismatch'`
 *   - `.expected` — Skin entity bound to a forgeax::pbr-skin material
 *   - `.hint` — load the mesh via the gltf importer (cooker auto-routes the
 *     'forgeax::pbr-skin' shader for skinned primitives), or remove the Skin
 *     component to render the entity unskinned with a `Materials.standard` /
 *     `Materials.unlit` material
 *   - `.detail = { entity, actualShader }`
 */
export class SkinMaterialMismatchError extends Error {
  readonly code = 'skin-material-mismatch' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkinMaterialMismatchDetail;

  constructor(entity: number, actualShader: string | undefined) {
    const expected = "Skin entity's material first pass shader === 'forgeax::pbr-skin'";
    const hint = `entity ${entity} has Skin but material first pass shader is ${actualShader ?? '<empty>'}; load the mesh via the gltf importer (cooker auto-routes 'forgeax::pbr-skin' for skinned primitives), or remove the Skin component to render unskinned with Materials.standard / Materials.unlit`;
    super(
      `Skin / material mismatch on entity ${entity}: expected forgeax::pbr-skin, got ${actualShader ?? '<empty>'}`,
    );
    this.name = 'SkinMaterialMismatchError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { entity, actualShader };
  }
}

// ── MaterialSkinAttrMissingError ──────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'material-skin-attr-missing'`.
 *
 * Emitted at extract time when an entity's resolved
 * `MaterialAsset.passes[0].shader === 'forgeax::pbr-skin'` but its
 * referenced `MeshAsset.attributes.skinIndex` or `.skinWeight` is
 * `undefined` (the mesh was not authored with skin attributes).
 * `missing` enumerates which side is absent so AI consumers can branch
 * on `'skinIndex'` / `'skinWeight'` / `'both'` without parsing prose.
 */
export interface MaterialSkinAttrMissingDetail {
  readonly entity: number;
  readonly missing: 'skinIndex' | 'skinWeight' | 'both';
}

/**
 * Structured error for the pbr-skin material -> non-skin mesh direction
 * (feat-20260611-fox-skinning-vertex-attribute-chain M4 / w17 / D-5).
 *
 * Emitted at extract time; the entity draw is skipped (continue).
 *   - `.code = 'material-skin-attr-missing'`
 *   - `.expected` — mesh.attributes.skinIndex + skinWeight both present
 *   - `.hint` — switch the entity to a skinned glTF mesh authored with
 *     JOINTS_0 + WEIGHTS_0, or change the material to a non-skin shader via
 *     `Materials.standard` / `Materials.unlit`
 *   - `.detail = { entity, missing }`
 */
export class MaterialSkinAttrMissingError extends Error {
  readonly code = 'material-skin-attr-missing' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: MaterialSkinAttrMissingDetail;

  constructor(entity: number, missing: 'skinIndex' | 'skinWeight' | 'both') {
    const expected = 'pbr-skin material requires mesh.attributes.skinIndex + skinWeight';
    const hint = `entity ${entity} uses forgeax::pbr-skin but its MeshAsset is missing ${missing}; switch the entity to a skinned glTF mesh authored with JOINTS_0 + WEIGHTS_0, or change the material to a non-skin shader via Materials.standard / Materials.unlit`;
    super(
      `material/skin attribute mismatch on entity ${entity}: pbr-skin material with mesh missing ${missing}`,
    );
    this.name = 'MaterialSkinAttrMissingError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { entity, missing };
  }
}

// ── SkeletonResolveFailedError ─────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'skeleton-resolve-failed'`.
 *
 * Emitted at extract time when `assets.get<SkeletonAsset>(skin.skeleton)`
 * returns `null` / `undefined`. The skeleton handle is non-zero (the entity
 * declared a Skin) but the asset is not registered (importer drift /
 * AssetRegistry not warmed).
 */
export interface SkeletonResolveFailedDetail {
  readonly entity: number;
  readonly skeletonHandle: number;
}

/**
 * Structured error for unresolved SkeletonAsset handle at extract time
 * (feat-20260612-skin-palette-per-frame-upload M2 / m2-5).
 *
 * Emitted at extract time; the entity draw is skipped (continue), other
 * entities in the same frame keep extracting.
 *   - `.code = 'skeleton-resolve-failed'`
 *   - `.expected` — Skin.skeleton handle resolves to a registered SkeletonAsset
 *   - `.hint` — verify SkeletonAsset is imported into pack-index AND registered
 *     via AssetRegistry.register(handle, asset) before extractFrame
 *   - `.detail = { entity, skeletonHandle }`
 */
export class SkeletonResolveFailedError extends Error {
  readonly code = 'skeleton-resolve-failed' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SkeletonResolveFailedDetail;

  constructor(entity: number, skeletonHandle: number) {
    const expected = `Skin.skeleton handle ${skeletonHandle} resolves to a registered SkeletonAsset`;
    const hint = `entity ${entity} Skin.skeleton handle ${skeletonHandle} is not registered; check that the SkeletonAsset went through the gltf importer into pack-index AND that AssetRegistry.register was called for the handle before extractFrame runs`;
    super(`Skin skeleton resolve failed on entity ${entity}: handle ${skeletonHandle}`);
    this.name = 'SkeletonResolveFailedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { entity, skeletonHandle };
  }
}

// ── JointCountMismatchError ────────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'joint-count-mismatch'`.
 *
 * Emitted at extract time when `Skin.joints.length !== SkeletonAsset.jointCount`.
 * `expected` is the SkeletonAsset's jointCount (the source of truth);
 * `actual` is the entity's `Skin.joints.length` (the runtime entity reference
 * list materialized at post-spawn time).
 */
export interface JointCountMismatchDetail {
  readonly entity: number;
  readonly expected: number;
  readonly actual: number;
}

/**
 * Structured error for SkinAsset.joints[] vs SkeletonAsset.jointCount disagreement
 * (feat-20260612-skin-palette-per-frame-upload M2 / m2-5).
 *
 * Emitted at extract time; the entity draw is skipped (continue).
 *   - `.code = 'joint-count-mismatch'`
 *   - `.expected` — Skin.joints.length === SkeletonAsset.jointCount
 *   - `.hint` — verify SkinAsset.joints[] and SkeletonAsset jointPaths[]
 *     come from the same glTF skin node
 *   - `.detail = { entity, expected, actual }`
 */
export class JointCountMismatchError extends Error {
  readonly code = 'joint-count-mismatch' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: JointCountMismatchDetail;

  constructor(entity: number, expected: number, actual: number) {
    const expectedStr = `Skin.joints.length === SkeletonAsset.jointCount (=${expected})`;
    const hint = `entity ${entity}: Skin.joints.length=${actual} disagrees with SkeletonAsset.jointCount=${expected}; verify SkinAsset.joints[] and SkeletonAsset jointPaths[] come from the same glTF skin node`;
    super(
      `joint count mismatch on entity ${entity}: SkeletonAsset.jointCount=${expected}, Skin.joints.length=${actual}`,
    );
    this.name = 'JointCountMismatchError';
    this.expected = expectedStr;
    this.hint = hint;
    this.detail = { entity, expected, actual };
  }
}

// ── JointEntityDanglingError ──────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'joint-entity-dangling'`.
 *
 * Emitted at extract time when `Skin.joints[i]` points at an Entity that has
 * been despawned (or lost its Transform component) so
 * `worldInternal._getArrayView(jointEntity, Transform, 'world')` returns
 * undefined. `jointIndex` is the position within `Skin.joints[]`.
 */
export interface JointEntityDanglingDetail {
  readonly entity: number;
  readonly jointIndex: number;
}

/**
 * Structured error for despawned (or Transform-less) joint Entity at extract
 * time (feat-20260612-skin-palette-per-frame-upload M2 / m2-5).
 *
 * Distinct from the pre-existing `SkinJointDespawnedError` which fires from
 * advanceAnimationPlayer (animation-stage); this one fires from extractFrame
 * (palette-upload stage) when the per-joint world mat4 view is missing.
 *
 * Emitted at extract time; the entity draw is skipped (continue).
 *   - `.code = 'joint-entity-dangling'`
 *   - `.expected` — Skin.joints[i] references a live Entity with Transform
 *   - `.hint` — sync Skin.joints[] when joint entities are despawned, or
 *     re-import the scene through the gltf importer to refresh Entity refs
 *   - `.detail = { entity, jointIndex }`
 */
export class JointEntityDanglingError extends Error {
  readonly code = 'joint-entity-dangling' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: JointEntityDanglingDetail;

  constructor(entity: number, jointIndex: number) {
    const expected = `Skin.joints[${jointIndex}] references a live Entity with Transform`;
    const hint = `entity ${entity} Skin.joints[${jointIndex}] points at a despawned (or Transform-less) Entity; sync Skin.joints[] when joint entities are despawned, or re-import the scene through the gltf importer to refresh Entity references`;
    super(`joint entity dangling on entity ${entity} at jointIndex ${jointIndex}`);
    this.name = 'JointEntityDanglingError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { entity, jointIndex };
  }
}

// ── PointShadowAtlasUninitializedError ─────────────────────────────────────

/**
 * Structured error for `ShadowAtlas.faceView` called before `ensure()`
 * allocated the cube_array texture. Replaces the prior bare
 * `throw new Error()` (Round-2 F-4: P3 closed-union compliance).
 *
 *   - `.code = 'point-shadow-atlas-uninitialized'`
 *   - `.expected` — call `ensure()` before iterating face views
 *   - `.hint` — gate `faceView` on `isAllocated()` or call `ensure()` once
 *     in the per-frame extract step before recording the 6 x N caster passes
 *   - `.detail = undefined` (no per-call data needed)
 */
export class PointShadowAtlasUninitializedError extends Error {
  readonly code = 'point-shadow-atlas-uninitialized' as const;
  readonly expected: string;
  readonly hint: string;

  constructor() {
    const expected = 'ShadowAtlas.ensure() invoked before faceView()';
    const hint =
      'Gate faceView on isAllocated() or call ensure() once in the per-frame extract step before iterating face views';
    super('ShadowAtlas.faceView called before ensure(); the cube_array texture is not allocated');
    this.name = 'PointShadowAtlasUninitializedError';
    this.expected = expected;
    this.hint = hint;
  }
}

// ── PointShadowAtlasBoundsViolationError ───────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'point-shadow-atlas-bounds-violation'`.
 *
 * Emitted by `ShadowAtlas.faceView` when `layer` falls outside `[0, layers)`
 * or `face` falls outside `[0, 6)`. Both axes are reported as
 * `{ axis, value, max }` so AI users discriminate without parsing the message.
 */
export interface PointShadowAtlasBoundsViolationDetail {
  readonly axis: 'layer' | 'face';
  readonly value: number;
  readonly max: number;
}

/**
 * Structured error for `ShadowAtlas.faceView(layer, face)` arguments outside
 * the allocated atlas range. Replaces the prior bare `throw new Error()`
 * (Round-2 F-4: P3 closed-union compliance).
 *
 *   - `.code = 'point-shadow-atlas-bounds-violation'`
 *   - `.expected` — `0 <= layer < layers && 0 <= face < 6`
 *   - `.hint` — clamp `shadowAtlasLayer` or face index before calling
 *     `faceView`; the cap on layers is `PointLightShadow` cardinality (4)
 *   - `.detail = { axis, value, max }` — discriminates layer vs face
 */
export class PointShadowAtlasBoundsViolationError extends Error {
  readonly code = 'point-shadow-atlas-bounds-violation' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: PointShadowAtlasBoundsViolationDetail;

  constructor(axis: 'layer' | 'face', value: number, max: number) {
    const expected = `0 <= ${axis} < ${max}`;
    const hint =
      axis === 'layer'
        ? `clamp PointLight.shadowAtlasLayer to [0, ${max}); the cap on layers equals PointLightShadow cardinality (4)`
        : `clamp face index to [0, ${max}); cube faces are indexed 0..5 in +X/-X/+Y/-Y/+Z/-Z order`;
    super(`ShadowAtlas.faceView ${axis} out of range: ${value} (must be in [0, ${max}))`);
    this.name = 'PointShadowAtlasBoundsViolationError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { axis, value, max };
  }
}

// ── RecoverError (feat-20260621-renderer-health-recover-skeleton M1) ─────────

/**
 * Closed union of recover() error codes.
 *
 * Exactly 4 members (feat-20260622-s5 M3 / D-2 add-only minor; the S3
 * skeleton shipped the first two):
 *   - `'recover-not-needed'` — health state is `'alive'`, no recovery required
 *     (also returned after a successful recover: the renderer is alive again,
 *     so a second recover() is a no-op signal — A-AC-08 idempotency)
 *   - `'recover-not-implemented'` — **reserved**. The S3 skeleton returned this
 *     for any degraded state; M3 implements recover() so this code is no longer
 *     produced. Kept in the union (not deleted) so consumers' exhaustive
 *     switches stay valid — AGENTS.md Change stance: `*ErrorCode` unions evolve
 *     add-only minor, never remove a member
 *   - `'recover-adapter-unavailable'` — rebuild requested a new adapter but
 *     `requestAdapter` returned no adapter (driver / GPU may have been reset)
 *   - `'recover-device-unavailable'` — an adapter was obtained but
 *     `requestDevice` failed or threw (device creation is driver-dependent)
 *
 * On both failure codes the health state stays `'device-lost'` (recover() never
 * fakes the renderer back to `'alive'` on failure — A-AC-07). recover() is a
 * single idempotent attempt: no retry loop, no backoff, no timer (A-OOS-1).
 *
 * AI users exhaustively switch without default; TS guards completeness.
 */
// biome-ignore format: single-line union keeps the A-AC-09 grep gate (exactly 4 `recover-*` literals on the definition line) stable
export type RecoverErrorCode = 'recover-not-needed' | 'recover-not-implemented' | 'recover-adapter-unavailable' | 'recover-device-unavailable';

/**
 * Structured error for `Renderer.recover()` failures.
 *
 * Carries the standard 3-field surface per AGENTS.md error model:
 *   - `.code: RecoverErrorCode` — closed union discriminant
 *   - `.expected: string` — expected-state description
 *   - `.hint: string` — actionable recovery guidance
 *
 * No `.detail` field: each code has fixed semantics with no variable data.
 */
export class RecoverError extends Error {
  readonly code: RecoverErrorCode;
  readonly expected: string;
  readonly hint: string;

  constructor(code: RecoverErrorCode) {
    let message: string;
    let expected: string;
    let hint: string;
    switch (code) {
      case 'recover-not-needed':
        message = 'recover-not-needed: renderer is not in a degraded state';
        expected =
          'renderer is healthy; call health() first to confirm degraded state before calling recover()';
        hint = 'call health() first to confirm degraded state before calling recover()';
        break;
      case 'recover-not-implemented':
        message = 'recover-not-implemented: self-heal recovery is not yet implemented';
        expected = 'recovery is not yet implemented; self-heal lands in S5';
        hint = 'self-heal recovery lands in S5; health().reason still reflects the degraded state';
        break;
      case 'recover-adapter-unavailable':
        message = 'recover-adapter-unavailable: requestAdapter returned no adapter during rebuild';
        expected = 'requestAdapter returned null; driver/GPU may have been reset';
        hint = 'retry recover() after a host-chosen delay; adapter availability is transient';
        break;
      case 'recover-device-unavailable':
        message = 'recover-device-unavailable: requestDevice failed or threw during rebuild';
        expected = 'requestDevice failed or threw';
        hint = 'retry recover() after a host-chosen delay; device creation is driver-dependent';
        break;
    }
    super(message);
    this.code = code;
    this.expected = expected;
    this.hint = hint;
    this.name = 'RecoverError';
  }
}

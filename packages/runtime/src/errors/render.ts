// @forgeax/engine-runtime -- render cluster error classes.
//
// feat-20260704-runtime-tier1-decomposition M2 / w8 (D-3): the monolithic
// errors.ts RuntimeErrorCode / RuntimeError top-level aggregate unions are
// decomposed into five per-cluster files (render / asset / skin / recover /
// environment). Each cluster owns a closed *ErrorCode code union + a closed
// *Error class union; error class names, .code literals, and .detail shapes
// are preserved byte-for-byte (OOS-4: zero semantic change).
//
// The render cluster holds the shadow / HDRP cluster-forward + deferred /
// g-buffer / point-shadow-atlas / video-upload / vertex-storage-buffer render
// path errors. ShadowInvalidConfigError is consumed by the DirectionalLight /
// SpotLight / PointLightShadow component validators (forward cross-directory
// import, no cycle -- research Finding C2).

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
 * splitLambda / cascadeBlend / shadowDistance) and `PointLightShadow.validate()`
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

// ── EquirectProjectionFailedError ────────────────────────────────────────────

/**
 * Detail for `RuntimeErrorCode 'equirect-projection-failed'`.
 *
 * Emitted when the equirect-to-cubemap IBL projection fails for the equirect
 * handle referenced by a `Skylight` / `SkyboxBackground` component. The handle
 * id is carried so AI users can trace which equirect source failed projection.
 * Degradation: the record arm records `status:'failed'`, binds the white-cube
 * fallback, fires this error ONCE, and does NOT retry the projection.
 *
 * feat-20260630 D-5: structured error with detail carrying the handle id.
 */
export interface EquirectProjectionFailedDetail {
  readonly handle: number;
}

/**
 * Structured error for a failed equirect-to-cubemap IBL projection.
 *
 * Emitted by the record stage when the internal cubemap projection for an
 * equirect handle returns a failure (or records `status:'failed'`). Four-field
 * surface per AGENTS.md error model:
 *   - `.code = 'equirect-projection-failed'` (closed RuntimeErrorCode)
 *   - `.expected` — equirect-to-cubemap projection + IBL precompute succeeds
 *   - `.hint` — declare `Skylight{equirect}` with a valid HDR equirect source;
 *     check `device.caps.rgba16floatRenderable`. The projection is internal —
 *     there is no user upload call to retry
 *   - `.detail = { handle }` — the numeric equirect handle id for diagnostics
 */
export class EquirectProjectionFailedError extends Error {
  readonly code = 'equirect-projection-failed' as const;
  readonly expected: string;
  readonly hint: string;
  readonly detail: EquirectProjectionFailedDetail;

  constructor(handle: number) {
    const expected = `equirect handle ${handle} projects to a GPU cubemap + IBL precompute`;
    const hint =
      `equirect handle ${handle} referenced by Skylight/SkyboxBackground failed projection; ` +
      `declare Skylight{equirect} with a valid HDR equirect source and check device.caps.rgba16floatRenderable. ` +
      `The projection is internal (no user upload call); the record arm does not retry`;
    super(`equirect handle ${handle} cubemap projection failed`);
    this.name = 'EquirectProjectionFailedError';
    this.expected = expected;
    this.hint = hint;
    this.detail = { handle };
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

// ── VideoUploadUnsupportedError ─────────────────────────────────────────

/**
 * Structured error for `RuntimeErrorCode 'video-upload-unsupported'`
 * (feat-20260623-world-space-video-asset M3 / w11 — AC-10).
 *
 * Fired by the per-frame record stage (`videoTextureView`) when a VideoPlayer
 * entity can reach neither video upload path this frame: the general
 * `copyExternalImageToTexture` path (no host HTMLVideoElement resolved via
 * `VideoElementProvider`) AND the high-perf `GPUExternalTexture` path
 * (capability absent). The engine surfaces this explicit failure rather than
 * silently rendering a stale/garbage texture (charter P3, plan-strategy D-6).
 *   - `.code = 'video-upload-unsupported'`
 *   - `.expected` — at least one upload path available (host element or
 *     GPUExternalTexture capability)
 *   - `.hint` — actionable recovery: use a static texture or switch backend
 *   - `.detail` — undefined (no narrowed detail variant)
 */
export class VideoUploadUnsupportedError extends Error {
  readonly code = 'video-upload-unsupported' as const;
  readonly expected: string;
  readonly hint: string;

  constructor() {
    const expected =
      'at least one video upload path available: a host HTMLVideoElement (general copyExternalImageToTexture path) or GPUExternalTexture capability (high-perf path)';
    const hint =
      'this backend exposes no usable video upload path; render a static texture instead, or switch to a WebGPU backend that supports video texture upload';
    super('video upload unsupported — no general or high-perf path available');
    this.name = 'VideoUploadUnsupportedError';
    this.expected = expected;
    this.hint = hint;
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

// -- RenderErrorCode / RenderError closed unions --------------------------------

/**
 * Closed union of render-cluster error codes. AI users perform exhaustive
 * `switch (err.code)` without default; TS guards completeness.
 */
export type RenderErrorCode =
  | 'shadow-invalid-config'
  | 'equirect-projection-failed'
  | 'hdrp-caps-insufficient'
  | 'hdrp-light-budget-exceeded'
  | 'hdrp-index-list-overflow'
  | 'hdrp-deferred-caps-insufficient'
  | 'gbuffer-rt-alloc-failed'
  | 'gbuffer-attachment-count-mismatch'
  | 'point-shadow-atlas-uninitialized'
  | 'point-shadow-atlas-bounds-violation'
  | 'video-upload-unsupported'
  | 'vertex-storage-buffer-unavailable';

/**
 * Closed union of the render-cluster structured error classes, each carrying a
 * `RenderErrorCode` discriminant on `.code`.
 */
export type RenderError =
  | ShadowInvalidConfigError
  | EquirectProjectionFailedError
  | HdrpCapsInsufficientError
  | HdrpLightBudgetExceededError
  | HdrpIndexListOverflowError
  | HdrpDeferredCapsInsufficientError
  | GbufferRtAllocFailedError
  | GbufferAttachmentCountMismatchError
  | PointShadowAtlasUninitializedError
  | PointShadowAtlasBoundsViolationError
  | VideoUploadUnsupportedError
  | VertexStorageBufferUnavailableError;

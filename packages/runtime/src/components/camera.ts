// @forgeax/engine-runtime - Camera (projection variant + ortho extension).
//
// Schema: 9 f32 columns — perspective quartet (fov + aspect + near + far)
// + projection discriminator (0 = perspective, 1 = orthographic) + ortho
// quartet (left + right + bottom + top). The view matrix continues to be
// derived from the entity's Transform (AC-06 case B fires
// 'render-system-no-camera' when 0 such entities exist).
//
// Projection discriminator:
//   projection === 0 → perspective path; RenderSystem builds
//                      mat4.perspective(out, fov, aspect, near, far).
//                      WebGPU [0, 1] NDC z; perspective reverse-Z hook is
//                      a future spin-off path (plan-strategy §R-7) kept
//                      outside M3 scope — the short-name mat4.perspective
//                      already writes [0, 1] NDC, matching the ortho branch.
//   projection === 1 → orthographic path; RenderSystem builds
//                      mat4.orthographic(out, left, right, bottom, top,
//                      near, far) (WebGPU [0, 1] NDC; same z convention).
//
// Naming convention: forgeax uses the bare `Camera` name (no `Component`
// suffix) to follow the unity-style flavor for "individuating" component
// names per plan-strategy 7.2 + D-Q5a user lock.
//
// Related: requirements §AC-16 (Camera Ortho + Box3 / Sphere);
//          plan-strategy §M3 range + §R-7 risk (single perspective camera
//          in hello-room does NOT trigger depth-func conflict; multi-camera
//          mixed perspective + ortho deferred to feat-future-camera-depth-func);
//          plan-tasks.json w9 acceptanceCheck.

import { defineComponent, type ShapeOf } from '@forgeax/engine-ecs';

/**
 * Projection discriminator literal union (AC-16 narrowing surface).
 * Exposed for consumer code that maps `camera.projection` numeric values back
 * to a switch-able string literal (e.g. RenderSystem dispatch / inspector
 * snapshot rendering).
 */
export type CameraProjection = 'perspective' | 'orthographic';

/** Numeric encoding of perspective projection (schema value for `projection`). */
export const CAMERA_PROJECTION_PERSPECTIVE = 0;
/** Numeric encoding of orthographic projection (schema value for `projection`). */
export const CAMERA_PROJECTION_ORTHOGRAPHIC = 1;

/**
 * Map a `camera.projection` numeric value to the closed `CameraProjection`
 * string-literal union. Values other than 0 / 1 fall back to `'perspective'`
 * (defensive for defaulted / uninitialised entities; charter proposition 4
 * no silent exception).
 */
export function cameraProjectionFromF32(value: number): CameraProjection {
  return value === CAMERA_PROJECTION_ORTHOGRAPHIC ? 'orthographic' : 'perspective';
}

/**
 * Tone-mapping mode discriminator literal union (AC-01 narrowing surface;
 * feat-20260519-tonemap-reinhard-mvp / M1).
 *
 * Two members for the MVP:
 *   `'none'`              - default; render-target stays `bgra8unorm-srgb`
 *                            and the geometry pass writes directly to the
 *                            swap-chain (zero-overhead opt-out path).
 *   `'reinhard-extended'` - Reinhard 2002 extended (luminance-domain) opt-in;
 *                            geometry pass routes through an `rgba16float`
 *                            HDR target and a fullscreen tonemap pass
 *                            (`packages/shader/src/tonemap.wgsl`).
 *
 * Future modes (`'aces'` / `'agx'`) are deferred per requirements section
 * OOS-04; the closed union shape leaves room for additive growth without
 * breaking the f32 enum encoding (D-1).
 */
export type Tonemap =
  | 'none'
  | 'reinhard-extended'
  | 'linear'
  | 'cineon'
  | 'aces-filmic'
  | 'agx'
  | 'neutral';

/** Numeric encoding of the no-op tonemap path (schema value for `tonemap`). */
export const TONEMAP_NONE = 0;
/**
 * Numeric encoding of the Reinhard-extended tonemap path
 * (schema value for `tonemap`).
 */
export const TONEMAP_REINHARD_EXTENDED = 1;
/** Numeric encoding of the linear (identity after exposure) tonemap path. */
export const TONEMAP_LINEAR = 2;
/** Numeric encoding of the Cineon (Kodak log) tonemap path. */
export const TONEMAP_CINEON = 3;
/** Numeric encoding of the ACES filmic (Narkowicz 2015) tonemap path. */
export const TONEMAP_ACES_FILMIC = 4;
/** Numeric encoding of the AgX (Troy Sobotka / Blender 3.x) tonemap path. */
export const TONEMAP_AGX = 5;
/** Numeric encoding of the Khronos PBR neutral tonemap path. */
export const TONEMAP_NEUTRAL = 6;

/**
 * Map a `camera.tonemap` numeric value to the closed `Tonemap` string-literal
 * union. Values other than 0 / 1 fall back to `'none'` (charter proposition 4
 * no silent exception); shader-side `max(Y, 1e-5)` floor + opt-in default
 * keep this safe even when AI users pass a stale numeric.
 */
export function tonemapFromF32(value: number): Tonemap {
  switch (value) {
    case TONEMAP_REINHARD_EXTENDED:
      return 'reinhard-extended';
    case TONEMAP_LINEAR:
      return 'linear';
    case TONEMAP_CINEON:
      return 'cineon';
    case TONEMAP_ACES_FILMIC:
      return 'aces-filmic';
    case TONEMAP_AGX:
      return 'agx';
    case TONEMAP_NEUTRAL:
      return 'neutral';
    default:
      return 'none';
  }
}

/**
 * Inverse of {@link tonemapFromF32}: map the closed `Tonemap` string-literal
 * union to the u32 mode the tonemap WGSL `params.mode` switch reads. SSOT for
 * the mode encoding shared by the extract-stage built-in tonemap provider
 * (feat-20260621 M-A3 / w13: `Camera.tonemap` -> `forgeax::tonemap` 16B data)
 * and any other consumer. `'none'` maps to 0 (the tonemap pass never dispatches
 * on the LDR path, so 0 is only ever a placeholder).
 */
export function tonemapToU32(mode: Tonemap): number {
  switch (mode) {
    case 'reinhard-extended':
      return TONEMAP_REINHARD_EXTENDED;
    case 'linear':
      return TONEMAP_LINEAR;
    case 'cineon':
      return TONEMAP_CINEON;
    case 'aces-filmic':
      return TONEMAP_ACES_FILMIC;
    case 'agx':
      return TONEMAP_AGX;
    case 'neutral':
      return TONEMAP_NEUTRAL;
    default:
      return TONEMAP_NONE;
  }
}

/**
 * Anti-alias mode discriminator literal union
 * (feat-20260528-fxaa-post-processing / w2;
 *  feat-20260604-learn-render-4-10-anti-aliasing-msaa adds `'msaa'`).
 *
 * Three members:
 *   `'none'` - default; no anti-aliasing (zero-overhead opt-out path)
 *   `'fxaa'` - FXAA 3.11 fullscreen post-processing pass (screen-space, shading-aliasing)
 *   `'msaa'` - 4x hardware multi-sample anti-aliasing (geometry-edge coverage).
 *              Active on both HDR and LDR-swap-chain paths, so a default Camera
 *              (`tonemap='none'`) with `antialias='msaa'` is NOT a silent no-op.
 *
 * MSAA and FXAA are orthogonal: MSAA resolves geometry-edge aliasing, FXAA
 * resolves shading/high-frequency aliasing. Future modes (`'smaa'` / `'taa'`)
 * remain deferred.
 */
export type Antialias = 'none' | 'fxaa' | 'msaa';

/** Numeric encoding of anti-alias disabled (schema value for `antialias`). */
export const ANTIALIAS_NONE = 0;
/** Numeric encoding of FXAA anti-aliasing (schema value for `antialias`). */
export const ANTIALIAS_FXAA = 1;
/** Numeric encoding of MSAA multi-sample anti-aliasing (schema value for `antialias`). */
export const ANTIALIAS_MSAA = 2;

/**
 * Map a `camera.antialias` numeric value to the closed `Antialias`
 * string-literal union. Invalid values fail-fast with structured error (charter P3).
 */
export function antialiasFromF32(value: number): Antialias {
  if (value === ANTIALIAS_NONE) return 'none';
  if (value === ANTIALIAS_FXAA) return 'fxaa';
  if (value === ANTIALIAS_MSAA) return 'msaa';
  throw new RangeError(
    `Invalid antialias value: ${value}. Expected ${ANTIALIAS_NONE} (none), ${ANTIALIAS_FXAA} (fxaa), or ${ANTIALIAS_MSAA} (msaa).`,
  );
}

/**
 * Bloom enabled discriminator literal union
 * (feat-20260531-bloom-first-declarative-render-graph-pass / w2).
 *
 * Two members:
 *   `'off'` - default; no bloom post-processing (zero-overhead opt-out path)
 *   `'on'`  - bloom bright-pass + separable blur + composite pipeline
 *
 * Bloom is a discrete enum (0/1) — illegal values fail-fast with RangeError
 * (charter P3), matching antialiasFromF32 precedent.
 */
export type BloomEnabled = 'off' | 'on';

/** Numeric encoding of bloom disabled (schema value for `bloom`). */
export const BLOOM_DISABLED = 0;
/** Numeric encoding of bloom enabled (schema value for `bloom`). */
export const BLOOM_ENABLED = 1;

/**
 * Map a `camera.bloom` numeric value to the closed `BloomEnabled` string-literal
 * union. Invalid values fail-fast with structured error (charter P3).
 */
export function bloomEnabledFromF32(value: number): BloomEnabled {
  if (value === BLOOM_DISABLED) return 'off';
  if (value === BLOOM_ENABLED) return 'on';
  throw new RangeError(
    `Invalid bloom value: ${value}. Expected ${BLOOM_DISABLED} (off) or ${BLOOM_ENABLED} (on).`,
  );
}

/**
 * Camera projection parameters (perspective + orthographic variants) +
 * tonemap trio (mode + exposure + whitePoint).
 *
 * Camera transform comes from the entity's `Transform` (AI users
 * spawn camera entities with both components: see example below).
 *
 * Defaults (do not auto-apply; spawn explicitly for the perspective quartet):
 *   fov        = pi/4       - 45-degree vertical field of view
 *   aspect     = 16/9       - widescreen aspect (use canvas.width / canvas.height)
 *   near       = 0.1
 *   far        = 100
 *   projection = 0          - CAMERA_PROJECTION_PERSPECTIVE (layer-2)
 *   left       = -1, right  = 1, bottom = -1, top = 1  (orthographic; layer-2)
 *   tonemap    = 0          - TONEMAP_NONE (layer-2; opt-in path stays
 *                              0-overhead by default)
 *   exposure   = 1.0        - layer-2 default for the Reinhard-extended path
 *                              @applicableWhen tonemap === 'reinhard-extended'
 *   whitePoint = 4.0        - layer-2 default for the Reinhard-extended path
 *                              @applicableWhen tonemap === 'reinhard-extended'
 *                              @minimum 0 (shader floor `max(Y, 1e-5)` keeps
 *                              the divisor finite even at 0; D-O3)
 *   clearColor = [0, 0, 0, 1]
 *                            - feat-20260709 M3 / D-3: clear-color is one
 *                              inline `array<f32,4>` column (collapsed from the
 *                              feat-20260608 clearR/G/B/A quartet). Defaults to
 *                              opaque black; the record stage reads it
 *                              first-archetype-hit and uses the same
 *                              `[0, 0, 0, 1]` fallback when no Camera entity
 *                              exists (AC-05).
 *
 * MVP supports a single active camera (the first archetype iteration hit;
 * N>1 fires 'render-system-multi-camera' + uses first). Multi-viewport is
 * OOS (see feat-future-multi-viewport). The orthographic path reuses the
 * same near / far as the perspective path — both variants share the single
 * Camera archetype (17 scalar f32 columns + the `clearColor` array<f32,4>
 * column + the `autoAspect` bool column).
 *
 * @example Perspective camera at (0, 0, 3) looking down -Z (zero-config tonemap):
 *   world.spawn(
 *     { component: Transform, data: {
 *       pos: [0, 0, 3],
 *       quat: [0, 0, 0, 1],
 *       scale: [1, 1, 1],
 *     } },
 *     { component: Camera, data: {
 *       fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100,
 *     } },
 *   );
 *   // tonemap defaults to 0 (TONEMAP_NONE) - 0-overhead path.
 *
 * @example Opt-in Reinhard-extended tonemap (high-intensity HDR scene):
 *   world.spawn(
 *     { component: Transform, data: { ... } },
 *     { component: Camera, data: {
 *       fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100,
 *       tonemap: TONEMAP_REINHARD_EXTENDED,
 *       exposure: 1.0,
 *       whitePoint: 4.0,
 *     } },
 *   );
 *
 * @example Orthographic camera spanning [-10, 10]^2 on the near plane:
 *   world.spawn(
 *     { component: Transform, data: {
 *       pos: [0, 0, 5],
 *       quat: [0, 0, 0, 1],
 *       scale: [1, 1, 1],
 *     } },
 *     { component: Camera, data: {
 *       fov: 0, aspect: 1, near: 0.1, far: 100,
 *       projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
 *       left: -10, right: 10, bottom: -10, top: 10,
 *     } },
 *   );
 */
export const Camera = defineComponent('Camera', {
  fov: { type: 'f32' },
  aspect: { type: 'f32' },
  near: { type: 'f32' },
  far: { type: 'f32' },
  projection: { type: 'f32', default: 0 },
  left: { type: 'f32', default: -1 },
  right: { type: 'f32', default: 1 },
  bottom: { type: 'f32', default: -1 },
  top: { type: 'f32', default: 1 },
  tonemap: { type: 'f32', default: 0 },
  exposure: { type: 'f32', default: 1.0 },
  whitePoint: { type: 'f32', default: 4.0 },
  antialias: { type: 'f32', default: 0 },
  bloom: { type: 'f32', default: 0 },
  bloomThreshold: { type: 'f32', default: 1.0 },
  bloomIntensity: { type: 'f32', default: 1.0 },
  bloomBlurRadius: { type: 'f32', default: 4.0 },
  // feat-20260709 M3 / D-3: clear-color is one inline `array<f32,4>` column.
  // The earlier 4-scalar form (clearR/G/B/A) was chosen when this was believed
  // to be the only SoA-safe shape; the Transform (pos/quat/scale) and light
  // (direction/color) precedents disprove that -- an `array<f32,N>` IS an
  // inline stride-N SoA column, read on the hot path as `col[i*N+a]` with zero
  // allocation, so collapsing four scalars into one column removes three field
  // names a reader must track without changing the storage layout or read
  // pattern. Explicit layer-2 default `[0, 0, 0, 1]` (opaque black); the array
  // layer-3 fallback is all-zero, so the non-zero alpha MUST be declared here
  // (D-5).
  clearColor: { type: 'array<f32, 4>', default: new Float32Array([0, 0, 0, 1]) },
  // feat-20260617-host-engine-contract-and-video-cutscene / M3 / D-4: the
  // aspect-sync sidecar on the createApp(canvas) path writes
  // canvas.width / canvas.height into `aspect` every frame when this flag is
  // true. Reuses the existing `bool` column tier (AnimationPlayer.paused /
  // AudioSource.playing precedent) -- zero ECS infrastructure change. Default
  // true so demos that never touch aspect track the canvas automatically
  // (charter P1 default-is-correct); set false for render-to-texture /
  // split-screen cameras that drive aspect themselves. Read it via
  // world.get (readRow narrows bool -> JS boolean); the query-bundle path
  // returns a raw 0/1 number (the `!== 0` always-true trap).
  autoAspect: { type: 'bool', default: true },
});

// ─── Camera POD type (derived from Camera token — single source, AC-07) ─────
//
// ShapeOf<typeof Camera.schema> resolves the 19-field POD from the Camera
// token's schema, which is itself derived from Camera.fields[k].type (D-A7).
// This replaces the hand-maintained CameraDataPod interface — the field set
// lives exclusively in the Camera component definition above.
type CameraPod = ShapeOf<typeof Camera.schema>;

// ─── Camera factory functions (w13 SSOT refactoring) ─────────────────────
//
// Standalone factory functions that return 19-field CameraPod objects
// matching the Camera component column shape. Not static methods because
// TypeScript const-namespace merge is not supported, and Object.assign
// would break the Camera token's reference identity (archetype columns /
// queries key off the global Component.id carried by the token).
//
// Import as:
//   import { Camera, perspective, orthographic } from '@forgeax/engine-runtime';
//   world.spawn({ component: Camera, data: perspective({ fov: 60, aspect: 4/3 }) });
//
// Charter P1 progressive disclosure: Barrel re-exports put perspective
// / orthographic next to Camera in IDE autocomplete.
//
// D-A4 factory retention reason: perspective() / orthographic() carry
// required/optional parameter semantics that cannot be derived from
// the schema.  perspective requires fov + aspect (no universal default),
// orthographic requires left/right/bottom/top.  The schema/defaults system
// only records type + optional default value per field — it has no concept
// of "this field MUST be supplied by the caller."  The factories encode
// that contract at the TypeScript type level, which schema/defaults alone
// cannot express.  Per AC-07, the factories are kept; only the POD type
// and default literals are derived from the Camera token (SSOT).

interface CameraPerspectiveOpts {
  fov: number;
  aspect: number;
  near?: number;
  far?: number;
  /**
   * feat-20260617-host-engine-contract-and-video-cutscene / M3: when true
   * (the schema default), the aspect-sync sidecar on the createApp(canvas)
   * path overwrites `aspect` with `canvas.width / canvas.height` every frame.
   * Omit it for the default-correct behaviour; set `false` to opt out (the
   * factory then leaves `aspect` under your control -- render-to-texture,
   * split-screen). Cameras built on the bare `createRenderer` path never
   * receive aspect-sync regardless of this flag.
   */
  autoAspect?: boolean;
}

interface CameraOrthographicOpts {
  left: number;
  right: number;
  bottom: number;
  top: number;
  near?: number;
  far?: number;
}

/**
 * Build a CameraPod base from Camera.fields defaults (per-field SSOT).
 * Fields without a default (fov / aspect / near / far — OOS-5) are left
 * unset; caller fills them from opts or sentinel values.
 */
function cameraPodFromDefaults(): CameraPod {
  const base: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(Camera.fields)) {
    if ('default' in field && field.default !== undefined) {
      base[key] = field.default;
    }
  }
  return base as CameraPod;
}

/**
 * Convenience factory: perspective CameraData POD.
 *
 * `fov` and `aspect` are required (no sensible universal default).
 * `near` defaults to 0.1, `far` defaults to 100.
 * Orthographic quartet defaults to [-1, 1]x[-1, 1]; tonemap defaults to
 * TONEMAP_NONE (0-overhead path).
 *
 * When `autoAspect` is `true` (the default once shipped in M3), the
 * aspect-sync sidecar on the `createApp(canvas)` path automatically writes
 * `canvas.width / canvas.height` into `Camera.aspect` every frame. Set
 * `autoAspect = false` to opt out (render-to-texture, split-screen).
 * Cameras on the `createRenderer` path do not receive aspect-sync.
 *
 * @see {@link https://github.com/Forgeax/forgeax-engine/blob/main/docs/how-to/2026-06-18-host-engine-contract.md | Host-engine contract SSOT}
 *
 * @example
 * ```ts
 * import { Camera, perspective } from '@forgeax/engine-runtime';
 * world.spawn(
 *   { component: Camera, data: perspective({ fov: Math.PI / 3, aspect: 4 / 3 }) }
 * ).unwrap();
 * ```
 *
 * @example With explicit near/far:
 * ```ts
 * const camData = perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.01, far: 1000 });
 * world.spawn({ component: Camera, data: camData }).unwrap();
 * ```
 *
 * @example With non-default clear color (default is `[0, 0, 0, 1]`).
 * `clearColor` is an inline `array<f32,4>` field on `Camera`; spread the
 * factory then override:
 * ```ts
 * world.spawn({
 *   component: Camera,
 *   data: { ...perspective({ fov: Math.PI / 3, aspect: 4 / 3 }), clearColor: [0, 1, 0, 1] },
 * }).unwrap();
 * ```
 */
export function perspective(opts: CameraPerspectiveOpts): CameraPod {
  return {
    // cameraPodFromDefaults() reads autoAspect's schema default (true), so an
    // omitted opts.autoAspect lands the default-correct value; an explicit
    // false overrides it below (D-4: factory one-step opt-out, charter P1).
    ...cameraPodFromDefaults(),
    fov: opts.fov,
    aspect: opts.aspect,
    near: opts.near ?? 0.1,
    far: opts.far ?? 100,
    projection: CAMERA_PROJECTION_PERSPECTIVE,
    ...(opts.autoAspect !== undefined ? { autoAspect: opts.autoAspect } : {}),
  };
}

/**
 * Convenience factory: orthographic CameraData POD.
 *
 * All four ortho bounds (`left` / `right` / `bottom` / `top`) are required.
 * `near` defaults to 0.1, `far` defaults to 100.
 * Perspective fields get sentinel defaults (fov=0, aspect=1) for column
 * alignment with the 12-field schema.
 *
 * @example
 * ```ts
 * import { Camera, orthographic } from '@forgeax/engine-runtime';
 * world.spawn(
 *   { component: Camera, data: orthographic({
 *     left: -10, right: 10, bottom: -10, top: 10,
 *   }) }
 * ).unwrap();
 * ```
 *
 * @example Screen-aligned orthographic for pixel-unit rendering:
 * ```ts
 * const camData = orthographic({ left: 0, right: 800, bottom: 600, top: 0 });
 * world.spawn({ component: Camera, data: camData }).unwrap();
 * ```
 */
export function orthographic(opts: CameraOrthographicOpts): CameraPod {
  return {
    ...cameraPodFromDefaults(),
    fov: 0,
    aspect: 1,
    near: opts.near ?? 0.1,
    far: opts.far ?? 100,
    projection: CAMERA_PROJECTION_ORTHOGRAPHIC,
    left: opts.left,
    right: opts.right,
    bottom: opts.bottom,
    top: opts.top,
  };
}

// @forgeax/engine-render - host-side light helpers (M2 / w12).
//
// Pure-function single-shot conversion helpers for the SpotLight + PointLight
// extract path. Host calls each helper once per light entity per frame; the
// shader then sees only pre-computed `cos*` / `invRangeSquared` values. The
// runtime range owner is the revision-pinned Three r184 squared window; KHR
// values remain an import/reference boundary and are not substituted here.
//
// AC anchors: requirements AC-03 (deg -> rad -> cos host two-step
// conversion) + AC-08 (a + b) (KHR quartic + range = 0 NaN protection
// boundary).
//
// Plan-strategy anchors: D-S2 (cone unit deg API + cos shader optimization
// transparent to AI users) + D-S5 (Layer 1 host-side range = 0 ->
// invRangeSquared = 1e8 protects the 0 * Infinity = NaN intermediate).

import { err, ok, type Result } from '@forgeax/engine-types';
import { SpawnLightInvalidBoundsError } from '../errors/ecs-validation';
import { ShadowInvalidConfigError } from '../errors/render';

export type LightValidationError = SpawnLightInvalidBoundsError | ShadowInvalidConfigError;
export type LightValidationResult = Result<void, LightValidationError>;

const RANGE_ZERO_FALLBACK_INV_R2 = 1e8;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Convert SpotLight cone half-angle (degrees) to its cosine.
 *
 * Single-shot deg -> rad -> cos conversion executed once per spot light
 * entity per frame on the host; the GPU shader sees only `cosInner` /
 * `cosOuter` so its falloff path stays branch-free
 * (`smoothstep(cosOuter, cosInner, dot(L, -lightDir))`).
 *
 * @param deg cone half-angle in degrees (component schema field
 *            `innerConeDeg` / `outerConeDeg`)
 * @returns `cos(deg * pi / 180)`
 */
export function degToCos(deg: number): number {
  return Math.cos(deg * DEG_TO_RAD);
}

/**
 * Convert PointLight / SpotLight `range` (meters) to `1 / range^2`.
 *
 * Three-branch fold supplies `1 / range^2` for the Three r184 finite-range
 * window `clamp(1 - (d / range)^4, 0, 1)^2`:
 *
 *   - `range = +Infinity` -> `0` (no truncation; quartic factor collapses
 *     to `1`, falloff reduces to plain `1 / d^2`).
 *   - `range = 0` -> `1e8` (host safety boundary; glTF `range: 0` is mapped
 *     to the no-cutoff `Infinity` value before this helper is called).
 *   - `range > 0` -> `1 / (range * range)` (standard quartic factor).
 *
 * @param range meters (component schema field `range`); `+Infinity` is the
 *              KHR no-truncation default
 * @returns `1 / range^2` with three-branch NaN protection
 */
export function computeInvRangeSquared(range: number): number {
  if (range === Number.POSITIVE_INFINITY) return 0;
  if (range === 0) return RANGE_ZERO_FALLBACK_INV_R2;
  return 1 / (range * range);
}

/**
 * feat-20260709 M2 / D-1: shared zero/missing-direction validate for
 * DirectionalLight + SpotLight. `direction` has no layer-2 default, so an
 * omitted direction lands the array layer-3 all-zero -- the same illegal state
 * as an explicit zero vector. SSOT for the rejection so the two lights cannot
 * drift. Returns the structured error to reject, or `null` when the direction
 * is a valid non-zero vector.
 */
export function validateDirection(
  componentName: 'DirectionalLight' | 'SpotLight',
  direction: ArrayLike<number> | undefined,
): SpawnLightInvalidBoundsError | null {
  const dir = direction;
  if (dir === undefined || ((dir[0] ?? 0) === 0 && (dir[1] ?? 0) === 0 && (dir[2] ?? 0) === 0)) {
    return new SpawnLightInvalidBoundsError(
      componentName,
      'direction',
      dir === undefined ? [0, 0, 0] : [dir[0] ?? 0, dir[1] ?? 0, dir[2] ?? 0],
    );
  }
  return null;
}

/** Validate directional-light payloads at the render owner boundary. */
export function validateDirectionalLightData(
  data: Readonly<Record<string, unknown>>,
): LightValidationResult {
  const directionError = validateDirection(
    'DirectionalLight',
    data.direction as ArrayLike<number> | undefined,
  );
  if (directionError !== null) return err(directionError);
  if (data.castShadow === false) return ok(undefined);

  const mapSize = (data.mapSize as number | undefined) ?? 2048;
  if (mapSize < 1) return err(new ShadowInvalidConfigError('mapSize', mapSize, 1));
  const cascadeCount = (data.cascadeCount as number | undefined) ?? 4;
  if (cascadeCount < 1 || cascadeCount > 4 || !Number.isInteger(cascadeCount)) {
    return err(new ShadowInvalidConfigError('cascadeCount', cascadeCount, 1, 4));
  }
  const splitLambda = (data.splitLambda as number | undefined) ?? 0.75;
  if (splitLambda < 0 || splitLambda > 1) {
    return err(new ShadowInvalidConfigError('splitLambda', splitLambda, 0, 1));
  }
  const cascadeBlend = (data.cascadeBlend as number | undefined) ?? 0.2;
  if (cascadeBlend < 0 || cascadeBlend > 0.5) {
    return err(new ShadowInvalidConfigError('cascadeBlend', cascadeBlend, 0, 0.5));
  }
  const pcfKernelSize = (data.pcfKernelSize as number | undefined) ?? 3;
  if (pcfKernelSize < 1 || pcfKernelSize % 2 === 0) {
    return err(new ShadowInvalidConfigError('pcfKernelSize', pcfKernelSize, 1));
  }
  const shadowDistance = (data.shadowDistance as number | undefined) ?? 200;
  if (shadowDistance <= 0) {
    return err(new ShadowInvalidConfigError('shadowDistance', shadowDistance, 0, '>'));
  }
  return ok(undefined);
}

/** Validate spot-light payloads at the render owner boundary. */
export function validateSpotLightData(
  data: Readonly<Record<string, unknown>>,
): LightValidationResult {
  const directionError = validateDirection(
    'SpotLight',
    data.direction as ArrayLike<number> | undefined,
  );
  if (directionError !== null) return err(directionError);
  if (data.castShadow === false) return ok(undefined);

  const range = (data.range as number | undefined) ?? 10;
  if (typeof range !== 'number' || Number.isNaN(range) || range < 0) {
    return err(new SpawnLightInvalidBoundsError('SpotLight', 'range', range));
  }
  const innerConeDeg = (data.innerConeDeg as number | undefined) ?? 0;
  const outerConeDeg = (data.outerConeDeg as number | undefined) ?? 45;
  if (outerConeDeg > 90) {
    return err(new SpawnLightInvalidBoundsError('SpotLight', 'outerNinety', outerConeDeg));
  }
  if (outerConeDeg <= innerConeDeg) {
    return err(new SpawnLightInvalidBoundsError('SpotLight', 'innerOuter', outerConeDeg));
  }
  const mapSize = (data.mapSize as number | undefined) ?? 2048;
  if (mapSize < 1) return err(new ShadowInvalidConfigError('mapSize', mapSize, 1));
  const nearPlane = data.nearPlane as number | undefined;
  const farPlane = data.farPlane as number | undefined;
  if (nearPlane !== undefined && farPlane !== undefined && farPlane <= nearPlane) {
    return err(new ShadowInvalidConfigError('farPlane', farPlane, nearPlane));
  }
  const pcfKernelSize = (data.pcfKernelSize as number | undefined) ?? 3;
  if (pcfKernelSize < 1 || pcfKernelSize % 2 === 0) {
    return err(new ShadowInvalidConfigError('pcfKernelSize', pcfKernelSize, 1));
  }
  return ok(undefined);
}

/** Validate point-light payloads at the render owner boundary. */
export function validatePointLightData(
  data: Readonly<Record<string, unknown>>,
): LightValidationResult {
  const range = (data.range as number | undefined) ?? 10;
  if (typeof range !== 'number' || Number.isNaN(range) || range < 0) {
    return err(new SpawnLightInvalidBoundsError('PointLight', 'range', range));
  }
  return ok(undefined);
}

/** Validate point-light shadow payloads at the render owner boundary. */
export function validatePointLightShadowData(
  data: Readonly<Record<string, unknown>>,
): LightValidationResult {
  const mapSize = (data.mapSize as number | undefined) ?? 512;
  if (mapSize < 1) return err(new ShadowInvalidConfigError('mapSize', mapSize, 1));
  const nearPlane = (data.nearPlane as number | undefined) ?? 0.1;
  const farPlane = (data.farPlane as number | undefined) ?? 25;
  if (farPlane <= nearPlane) {
    return err(new ShadowInvalidConfigError('farPlane', farPlane, nearPlane));
  }
  const pcfKernelSize = (data.pcfKernelSize as number | undefined) ?? 3;
  if (pcfKernelSize < 1 || pcfKernelSize % 2 === 0) {
    return err(new ShadowInvalidConfigError('pcfKernelSize', pcfKernelSize, 1));
  }
  return ok(undefined);
}

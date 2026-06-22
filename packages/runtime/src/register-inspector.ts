// register-inspector - Pure-function runtime inspector contributor
// (plan-tasks.json w4rb + plan-strategy §2.6).
//
// Top-level pure function `registerRuntimeInspector(reg, engine, world?)`
// registers runtime-specific JSON-RPC methods on a Registry interface from
// `@forgeax/engine-types`. P0 surface = single `renderer.info` method
// returning backend so AI users can discover the active rendering backend
// over the inspector wire without holding a Renderer reference.
//
// feat-20260519-light-casters-point-spot-pbr M5 / w25 (AC-11 b): the legacy
// single `runtime.lights.count` (DirectionalLight only, feat-20260518) is
// replaced one-cut by three orthogonal bucket methods —
// `runtime.lights.directionalCount` / `.pointCount` / `.spotCount` — each
// reporting the number of entities of that light kind. The alias is
// physically removed (no compat shim) per AGENTS.md change stance
// "optimal > compatible"; AI users branch on `lookupMethod === undefined`
// to detect the rename. Research Finding 11: Bevy / Three.js / Babylon
// all expose three independent counters per light kind.
//
// charter: proposition 1 (single registration entry) + proposition 3
// (Result<void, InspectorError>) + proposition 4 (explicit fail-fast on
// duplicate; reuses 'console-startup-failed' per §2.5 / §2.11) +
// proposition 5 (Handler signature shared with the ecs / pack / gltf
// contributor families).
//
// Pipeline isolation (architecture-principles #4): this module imports
// only `@forgeax/engine-types` (interface SSOT) + `@forgeax/engine-ecs`
// (World type for the lights query) + the local `Renderer` type; it
// never reaches into `@forgeax/engine-console` runtime class.

import {
  type Component,
  createQueryState,
  Entity,
  queryRun,
  type World,
} from '@forgeax/engine-ecs';
import type { Handler, RegisterMethodResult, Registry } from '@forgeax/engine-types';
import { DirectionalLight } from './components/directional-light';
import { PointLight } from './components/point-light';
import { SpotLight } from './components/spot-light';
import type { Renderer } from './renderer';

/**
 * Result alias for `registerRuntimeInspector`. Mirrors `RegisterMethodResult`
 * from `@forgeax/engine-types`.
 */
export type RegisterRuntimeInspectorResult = RegisterMethodResult;

/**
 * Register the runtime-specific inspection methods on a Registry instance.
 *
 * Methods registered:
 * - `renderer.info` : `{ backend: 'webgpu' }` exposes the active backend
 *   marker so AI users can discover the host's effective configuration
 *   without owning a Renderer reference (charter P5 consistent abstraction).
 * - `frustum.stats` : `{ culled: number, total: number }` returns the
 *   latest per-frame frustum-culling counters (feat-20260528 M5 / w14).
 *   Available without a World (reads engine.frustumStats directly).
 * - `runtime.lights.directionalCount` : `{ count: number }` (only when
 *   `world` is supplied) - returns the number of DirectionalLight entities.
 * - `runtime.lights.pointCount`       : `{ count: number }` (only when
 *   `world` is supplied) - returns the number of PointLight entities.
 * - `runtime.lights.spotCount`        : `{ count: number }` (only when
 *   `world` is supplied) - returns the number of SpotLight entities.
 *
 * AI users use the three bucket methods to assert that lighting is wired
 * (zero across all three is the silent-failure case the once-warn signal
 * routes to AGENTS.md Breaking changes 2026-05-19; charter P3).
 *
 * Same-name duplicate fails fast on the first conflict and returns
 * `Result.err(InspectorError, code: 'console-startup-failed')`. Reuse
 * across reloads requires a fresh `new Registry()` (plan-strategy §3.3
 * error path 1).
 *
 * @param reg    `Registry` instance from `@forgeax/engine-console` (or any
 *               implementation of the `Registry` interface in
 *               `@forgeax/engine-types`).
 * @param engine `Renderer` whose live state the handler exposes. The
 *               handler reads `engine.backend` lazily on each invocation.
 * @param world  Optional `World`; when supplied, the handler also
 *               registers the three light-bucket counter methods
 *               (feat-20260519 M5 / w25; replaces the feat-20260518
 *               single `runtime.lights.count` alias).
 */
export function registerRuntimeInspector(
  reg: Registry,
  engine: Renderer,
  world?: World,
): RegisterRuntimeInspectorResult {
  const infoHandler: Handler = () => ({
    backend: engine.backend,
  });
  const infoResult = reg.registerMethod('renderer.info', infoHandler);
  if (!infoResult.ok) return infoResult;

  // feat-20260528-frustum-culling M5 / w14: frustum.stats returns per-frame
  // culling counters from the extract stage. Available without a world
  // (reads engine.frustumStats directly) so AI users can inspect culling
  // stats over the inspector wire.
  const frustumStatsHandler: Handler = () => engine.frustumStats;
  const frustumResult = reg.registerMethod('frustum.stats', frustumStatsHandler);
  if (!frustumResult.ok) return frustumResult;

  if (world !== undefined) {
    const directional = registerLightBucket(
      reg,
      world,
      'runtime.lights.directionalCount',
      DirectionalLight,
    );
    if (!directional.ok) return directional;
    const point = registerLightBucket(reg, world, 'runtime.lights.pointCount', PointLight);
    if (!point.ok) return point;
    const spot = registerLightBucket(reg, world, 'runtime.lights.spotCount', SpotLight);
    if (!spot.ok) return spot;

    // ── feat-20260520-directional-light-shadow-mapping M1c / w11 ──────────
    //
    // Register shadow Inspector buckets: mapSize + lightSpaceMatrix read
    // from the renderer's directionalShadow getter (backed by PipelineState
    // cache updated per frame in render-system-record). debugReadback
    // triggers an async GPU readback of 5 depth pixels (D-5).
    //
    // charter F2/P5: POD-only — all values are JSON-serializable primitives
    // (number / number[] / null) so AI users assert numerically.

    const mapSizeHandler: Handler = () => {
      const info = engine.directionalShadow;
      return info !== null && info !== undefined ? { mapSize: info.mapSize } : { mapSize: 0 };
    };
    const mapSizeRes = reg.registerMethod(
      'runtime.lights.directionalShadow.mapSize',
      mapSizeHandler,
    );
    if (!mapSizeRes.ok) return mapSizeRes;

    const lsmHandler: Handler = () => {
      const info = engine.directionalShadow;
      return info !== null && info !== undefined
        ? { lightSpaceMatrix: info.lightSpaceMatrix }
        : { lightSpaceMatrix: null };
    };
    const lsmRes = reg.registerMethod(
      'runtime.lights.directionalShadow.lightSpaceMatrix',
      lsmHandler,
    );
    if (!lsmRes.ok) return lsmRes;

    const debugReadbackHandler: Handler = async () => {
      if (typeof engine.debugReadback !== 'function') return null;
      return engine.debugReadback();
    };
    const drRes = reg.registerMethod('runtime.shadow.debugReadback', debugReadbackHandler);
    if (!drRes.ok) return drRes;

    // feat-20260520-directional-light-shadow-mapping M2 / w14 (AC-12):
    // debugSampleShadowFactor emulates the shader's shadow factor on CPU
    // given world-space positions. Used by M2 dawn tests for numerical
    // assertion of occluded/lit shadow factor values without rendering.
    const debugSfHandler: Handler = async (params) => {
      if (typeof engine.debugSampleShadowFactor !== 'function') return null;
      const positions = (params as { positions: readonly [number, number, number][] })?.positions;
      if (!Array.isArray(positions)) return null;
      return engine.debugSampleShadowFactor(positions);
    };
    const dsfRes = reg.registerMethod('runtime.shadow.debugSampleShadowFactor', debugSfHandler);
    if (!dsfRes.ok) return dsfRes;
  }
  return infoResult;
}

function registerLightBucket(
  reg: Registry,
  world: World,
  methodName: string,
  component: Component,
): RegisterMethodResult {
  const handler: Handler = () => {
    let count = 0;
    const q = createQueryState({ with: [component, Entity] });
    queryRun(q, world, (bundle) => {
      count += bundle.Entity.self.length;
    });
    return { count };
  };
  return reg.registerMethod(methodName, handler);
}

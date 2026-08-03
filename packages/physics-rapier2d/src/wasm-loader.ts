// @forgeax/engine-physics-rapier2d — WASM loader for Rapier 2D compat variant.
//
// Dynamic import of @dimforge/rapier2d-compat (plan-strategy D-4: compat variant,
// zero Vite configuration).

import type { PhysicsErrorCode } from '@forgeax/engine-types';
import { PhysicsError } from '@forgeax/engine-types';

/**
 * The RAPIER module namespace — all constructors, types, and helpers exposed
 * by @dimforge/rapier2d-compat after init(). This is the shape of the default
 * export of the compat package.
 */
// biome-ignore lint/suspicious/noExplicitAny: Rapier compat namespace type
export type Rapier2DModule = any;

let rapierInstance: Rapier2DModule | null = null;
let loadingPromise: Promise<Rapier2DModule | PhysicsError> | null = null;

export async function loadRapier2D(): Promise<Rapier2DModule | PhysicsError> {
  if (rapierInstance !== null) return rapierInstance;
  if (loadingPromise !== null) return loadingPromise;

  loadingPromise = _doLoad();
  return loadingPromise;
}

async function _doLoad(): Promise<Rapier2DModule | PhysicsError> {
  try {
    const RAPIER = await import('@dimforge/rapier2d-compat');
    await RAPIER.default.init();
    rapierInstance = RAPIER.default;
    loadingPromise = null;
    return RAPIER.default;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    loadingPromise = null;
    return new PhysicsError({
      code: 'wasm-load-failed' as PhysicsErrorCode,
      expected: 'successful dynamic import and init of @dimforge/rapier2d-compat',
      hint: `dynamic import or init() failed: ${reason}. Check network, file path, and that @dimforge/rapier2d-compat is installed.`,
      detail: { code: 'wasm-load-failed', reason },
    });
  }
}

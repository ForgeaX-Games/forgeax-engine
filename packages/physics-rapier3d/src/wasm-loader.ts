// @forgeax/engine-physics-rapier3d — WASM loader for Rapier 3D compat variant.
//
// Dynamic import of @dimforge/rapier3d-compat (plan-strategy D-4: compat variant,
// zero Vite configuration).
//
// Usage:
//   const rapier = await loadRapier3D();
//   if ('code' in rapier) { /* handle PhysicsError */ }
//   const world = new rapier.World({ x: 0, y: -9.81, z: 0 });

import type { PhysicsErrorCode } from '@forgeax/engine-types';
import { PhysicsError } from '@forgeax/engine-types';

/**
 * The RAPIER module namespace — all constructors, types, and helpers exposed
 * by @dimforge/rapier3d-compat after init(). This is the shape of the default
 * export of the compat package.
 */
// biome-ignore lint/suspicious/noExplicitAny: Rapier compat namespace type
export type Rapier3DModule = any;

/** Cached RAPIER instance — loaded once, reused across frames. */
let rapierInstance: Rapier3DModule | null = null;

/** Loading promise — ensures concurrent callers share one init. */
let loadingPromise: Promise<Rapier3DModule | PhysicsError> | null = null;

/**
 * Load the Rapier 3D WASM module and initialise it.
 *
 * Uses dynamic import of the compat variant (zero Vite configuration per
 * plan-strategy D-4). The init() call is async but self-hosted — no external
 * .wasm file needed (Base64-inlined JS).
 *
 * Concurrent callers share a single loading promise; after the first
 * successful load the cached instance is returned synchronously.
 *
 * @returns the RAPIER module namespace on success, or a PhysicsError with
 *          code 'wasm-load-failed' if dynamic import or init() rejects.
 */
export async function loadRapier3D(): Promise<Rapier3DModule | PhysicsError> {
  if (rapierInstance !== null) return rapierInstance;
  if (loadingPromise !== null) return loadingPromise;

  loadingPromise = _doLoad();
  return loadingPromise;
}

async function _doLoad(): Promise<Rapier3DModule | PhysicsError> {
  try {
    const RAPIER = await import('@dimforge/rapier3d-compat');
    await RAPIER.default.init();
    rapierInstance = RAPIER.default;
    loadingPromise = null;
    return RAPIER.default;
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    loadingPromise = null;
    return new PhysicsError({
      code: 'wasm-load-failed' as PhysicsErrorCode,
      expected: 'successful dynamic import and init of @dimforge/rapier3d-compat',
      hint: `dynamic import or init() failed: ${reason}. Check network, file path, and that @dimforge/rapier3d-compat is installed.`,
      detail: { code: 'wasm-load-failed', reason },
    });
  }
}

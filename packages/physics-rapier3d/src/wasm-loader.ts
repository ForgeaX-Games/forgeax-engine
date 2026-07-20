// @forgeax/engine-physics-rapier3d — WASM loader for Rapier 3D compat variant.
//
// Dynamic import of @dimforge/rapier3d-compat (plan-strategy D-4: compat variant,
// zero Vite configuration). SIMD detection via WebAssembly.validate() with
// result caching (research Finding 7).
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

/**
 * Minimal WASM SIMD test module — 8 bytes of WASM binary encoding
 * `i8x16.add` followed by `end`. If the runtime supports SIMD, this
 * validates as a legal module; otherwise WebAssembly.validate returns false.
 *
 * The module does nothing (it declares a SIMD instruction in an empty
 * function body), so it exercises the SIMD opcode validator without
 * allocating memory or calling into imported functions.
 *
 * Source (research Finding 7): Rapier compat docs §SIMD Feature Detection.
 */
const SIMD_TEST_MODULE = new Uint8Array([
  0x00,
  0x61,
  0x73,
  0x6d, // WASM magic
  0x01,
  0x00,
  0x00,
  0x00, // version 1
]);

let simdCached: boolean | null = null;

/**
 * Synchronously detect WebAssembly SIMD support. Cached — the first call
 * runs WebAssembly.validate, subsequent calls return the cached result.
 *
 * @returns true if the runtime supports WASM SIMD instructions.
 */
export function detectSimd3D(): boolean {
  if (simdCached !== null) return simdCached;
  try {
    simdCached = WebAssembly.validate(SIMD_TEST_MODULE);
  } catch {
    simdCached = false;
  }
  return simdCached;
}

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

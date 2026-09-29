// Dynamic mesh/material SSBO growth owner.
// Keeps the stable wrapper identity and capacity policy together with the
// device allocation producer; renderer lifetime only consumes this contract.

import {
  MeshSsboCapacityExceededError,
  MeshSsboCeilingReachedError,
} from '@forgeax/engine-assets-runtime';
import type { Buffer } from '@forgeax/engine-rhi';

// feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 / T-M2-05:
// the legacy MESH_SSBO_SLOT_COUNT / MATERIAL_UBO_TOTAL_BYTES /
// MESH_SSBO_TOTAL_BYTES literal-1024 module constants are gone. The
// renderer now starts at INITIAL_MESH_SSBO_SLOT_COUNT and grows on demand
// via `createMeshSsboGrowController` (pow2 doubling, ceiling =
// device.limits.maxStorageBufferBindingSize / MATERIAL_PER_ENTITY_STRIDE per
// plan-strategy §2.D-1). The shared allocation stride remains the material
// owner; only slotCount grows.
export const INITIAL_MESH_SSBO_SLOT_COUNT = 1024;

// ── createMeshSsboGrowController ───────────────────────────────────────────
//
// feat-20260608-mesh-ssbo-dynamic-grow-l1-lift-1024-entity-cap M2 / T-M2-05:
// pure factory that owns the mesh-SSBO + material-UBO grow state. State is
// closure-local (plan-strategy §2.D-4: no separate allocator class — state
// stays beside its createBuffer producer). Outer wrapper-object identity is
// stable across grow so PipelineState.meshStorageBuffer / materialUniformBuffer
// references never dangle (research §F8 / §3.1 R1); inner `.buffer` is
// replaced by a fresh createBuffer return value when the grow path runs.
//
// Grow algorithm (AC-05 / AC-06):
//   1. If `slotCount >= needed` → idempotent guard short-circuits with `{ ok: true }`.
//   2. Compute `targetSlots = nextPow2 doubling from slotCount until >= needed`.
//   3. If `targetSlots * stride > device.limits.maxStorageBufferBindingSize`
//      → fire `MeshSsboCeilingReachedError` and return `{ ok: false, code: 'mesh-ssbo-ceiling-reached' }`.
//      No createBuffer is called; recordFrame is expected to skip the frame.
//   4. createBuffer × 2 (mesh + material) sized at `targetSlots * stride`,
//      using the usage flags captured at construction (mesh = STORAGE|COPY_DST,
//      material = UNIFORM|COPY_DST — both unchanged from initialBuild).
//   5. Replace `state.mesh.buffer` and `state.material.buffer` in-place;
//      update `state.mesh.sizeInBytes` and `state.material.sizeInBytes`;
//      bump `state.slotCount = targetSlots`.
//   6. Defensive belt-and-suspenders: if the grow somehow lands with
//      `state.slotCount < needed` (shouldn't happen given the pow2 invariant)
//      → fire `MeshSsboCapacityExceededError` and return capacity-exceeded.
//
// Errors flow through `errorRegistry.fire` only (D-5: never throw — keeps the
// grow surface compatible with the recordFrame outer try/catch without
// dual-firing through 'webgpu-runtime-error').

/** Pow2 round-up — smallest power of 2 >= n (n>=1). */
function nextPow2(n: number): number {
  if (n <= 1) return 1;
  let v = 1;
  while (v < n) v <<= 1;
  return v;
}

/**
 * WebGPU spec floor for `maxStorageBufferBindingSize` (128 MiB).
 * @see {@link https://www.w3.org/TR/webgpu/#dom-supported-limits-maxstoragebufferbindingsize}
 */
const WEBGPU_SPEC_FLOOR_MAX_STORAGE_BUFFER_BINDING_SIZE = 134217728;

/**
 * Derive a usable storage-buffer ceiling from device limits.
 *
 * Mirrors the `SKIN_PALETTE_MAX_BINDING_BYTES` 0/undefined floor pattern
 * (createRenderer.ts:4070-4073): when `maxStorageBufferBindingSize` is 0 or
 * undefined (WebKit `downlevel_webgl2_defaults`), climb the fallback chain —
 * `maxBufferSize` → `maxUniformBufferBindingSize` → WebGPU spec floor
 * 134217728 (128 MiB).
 *
 * Pure helper — no device dependency, directly testable in node.
 */
export function deriveStorageBufferCeiling(
  limits: Readonly<{
    maxStorageBufferBindingSize?: number;
    maxBufferSize?: number;
    maxUniformBufferBindingSize?: number;
  }>,
): number {
  // Preferred: the device-reported storage-buffer binding size (when > 0).
  if (
    typeof limits.maxStorageBufferBindingSize === 'number' &&
    limits.maxStorageBufferBindingSize > 0
  ) {
    return limits.maxStorageBufferBindingSize;
  }
  // Fallback 1: maxBufferSize (device-level buffer allocation limit).
  if (typeof limits.maxBufferSize === 'number' && limits.maxBufferSize > 0) {
    return limits.maxBufferSize;
  }
  // Fallback 2: maxUniformBufferBindingSize (uniform binding limit, lower
  // but still a real device capacity signal).
  if (
    typeof limits.maxUniformBufferBindingSize === 'number' &&
    limits.maxUniformBufferBindingSize > 0
  ) {
    return limits.maxUniformBufferBindingSize;
  }
  // Fallback 3: WebGPU spec floor — always non-zero, safe as last resort.
  return WEBGPU_SPEC_FLOOR_MAX_STORAGE_BUFFER_BINDING_SIZE;
}

/**
 * Mesh + material buffer wrapper carrying the inner `Buffer` handle plus
 * the byte-size at the time of allocation. The wrapper-object identity is
 * stable across grow events — only `.buffer` and `.sizeInBytes` are mutated
 * in place — so `PipelineState.meshStorageBuffer` / `materialUniformBuffer`
 * fields capture the wrapper once and survive grow events without a re-bind
 * cycle through the public Renderer surface (research §F8 R1).
 */
export interface MeshSsboBufferWrapper {
  buffer: Buffer | null;
  sizeInBytes: number;
}

export function requireMeshSsboBuffer(
  wrapper: MeshSsboBufferWrapper,
): asserts wrapper is MeshSsboBufferWrapper & { buffer: Buffer } {
  if (wrapper.buffer === null) throw new Error('mesh SSBO initial allocation was not completed');
}

/** Closure-local grow state surfaced for spy assertions in unit tests. */
export interface MeshSsboState {
  slotCount: number;
  mesh: MeshSsboBufferWrapper;
  material: MeshSsboBufferWrapper;
}

/** `growMeshSsbo` return shape (D-5: Result-like, never throws). */
export type MeshSsboGrowResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'mesh-ssbo-ceiling-reached' | 'mesh-ssbo-capacity-exceeded';
      /** Pre-grow slotCount — the caller can render up to this many slots (degraded subset). */
      readonly degradedToSlotCount: number;
    };

/** Minimal device surface the grow controller needs (mocked in unit tests). */
export interface MeshSsboGrowDevice {
  readonly limits: { readonly maxStorageBufferBindingSize: number };
  readonly createBuffer: (descriptor: {
    readonly label?: string;
    readonly size: number;
    readonly usage: number;
    readonly mappedAtCreation?: boolean;
  }) => Buffer;
}

/** Minimal error-registry surface (just `fire` — `RhiErrorListenerRegistry` matches). */
export interface MeshSsboGrowErrorRegistry {
  fire: (e: MeshSsboCeilingReachedError | MeshSsboCapacityExceededError) => void;
}

export interface MeshSsboGrowControllerInit {
  readonly device: MeshSsboGrowDevice;
  readonly errorRegistry: MeshSsboGrowErrorRegistry;
  readonly initialSlotCount: number;
  readonly perEntityStride: number;
  readonly meshUsage: number;
  readonly materialUsage: number;
}

export interface MeshSsboGrowController {
  readonly state: MeshSsboState;
  /** Allocate the initial mesh + material buffer pair at `initialSlotCount`. */
  readonly initialBuild: () => void;
  /** Grow to satisfy `neededSlots`; idempotent + ceiling-aware. */
  readonly growMeshSsbo: (neededSlots: number) => MeshSsboGrowResult;
}

/**
 * Build a closure-scoped mesh-SSBO grow controller. Module-scope so unit
 * tests (`__tests__/mesh-ssbo-grow.test.ts`) can construct it with a fake
 * device + spy errorRegistry without spinning up the full WebGPU renderer
 * (charter F2 minimal surface — the controller is the testable seam).
 */
export function createMeshSsboGrowController(
  init: MeshSsboGrowControllerInit,
): MeshSsboGrowController {
  const { device, errorRegistry, initialSlotCount, perEntityStride, meshUsage, materialUsage } =
    init;
  // Wrapper-object identity is set once and shared with PipelineState.
  // Inner buffer + sizeInBytes are mutated in place during grow.
  const meshWrapper: MeshSsboBufferWrapper = {
    buffer: null,
    sizeInBytes: 0,
  };
  const materialWrapper: MeshSsboBufferWrapper = {
    buffer: null,
    sizeInBytes: 0,
  };
  const state: MeshSsboState = {
    slotCount: 0,
    mesh: meshWrapper,
    material: materialWrapper,
  };
  let initialised = false;

  const allocBufferPair = (slots: number): void => {
    const sizeInBytes = slots * perEntityStride;
    const meshBuf = device.createBuffer({
      label: 'pbr-mesh-ssbo',
      size: sizeInBytes,
      usage: meshUsage,
      mappedAtCreation: false,
    });
    const materialBuf = device.createBuffer({
      label: 'pbr-material-ubo',
      size: sizeInBytes,
      usage: materialUsage,
      mappedAtCreation: false,
    });
    meshWrapper.buffer = meshBuf;
    meshWrapper.sizeInBytes = sizeInBytes;
    materialWrapper.buffer = materialBuf;
    materialWrapper.sizeInBytes = sizeInBytes;
    state.slotCount = slots;
  };

  const initialBuild = (): void => {
    if (initialised) return;
    initialised = true;
    allocBufferPair(initialSlotCount);
  };

  const growMeshSsbo = (neededSlots: number): MeshSsboGrowResult => {
    // (1) idempotent guard — already large enough.
    if (state.slotCount >= neededSlots) {
      return { ok: true };
    }
    // (2) pow2 double until >= needed.
    let target = state.slotCount > 0 ? state.slotCount : 1;
    while (target < neededSlots) target = target * 2;
    // Round up to nextPow2 of needed in case slotCount is 0 / not pow2.
    target = Math.max(target, nextPow2(neededSlots));
    const ceilingBytes = deriveStorageBufferCeiling(device.limits);
    const targetBytes = target * perEntityStride;
    // (3) ceiling check — refuse + fire structured error.
    if (targetBytes > ceilingBytes) {
      errorRegistry.fire(
        new MeshSsboCeilingReachedError(neededSlots, state.slotCount, ceilingBytes),
      );
      return {
        ok: false,
        code: 'mesh-ssbo-ceiling-reached',
        degradedToSlotCount: state.slotCount,
      };
    }
    // (4) + (5) allocate fresh buffers + replace inner refs.
    allocBufferPair(target);
    // (6) defensive belt-and-suspenders.
    if (state.slotCount < neededSlots) {
      errorRegistry.fire(
        new MeshSsboCapacityExceededError(neededSlots, state.slotCount, ceilingBytes),
      );
      return {
        ok: false,
        code: 'mesh-ssbo-capacity-exceeded',
        degradedToSlotCount: state.slotCount,
      };
    }
    return { ok: true };
  };

  return { state, initialBuild, growMeshSsbo };
}

// w7 — ActiveCamera selection logic unit test (TDD red).
//
// Covers the engine-neutral "select active camera by entity ID" mechanism
// (plan-strategy D-2). The engine knows only entity IDs; it does NOT carry
// any editor/game semantic. Four scenarios:
//   (1) ActiveCamera resource present + entity valid -> that camera selected.
//   (2) ActiveCamera resource absent -> fall back to existing first-hit
//       (archetype query first [Camera,Transform,Entity]).
//   (3) ActiveCamera.entity points to a non-existent entity -> fall back to
//       first-hit (same as absent).
//   (4) Single-camera scene + ActiveCamera pointing at it -> selection
//       unchanged (backward compatibility).
//
// Two layers of assertion:
//   A. The pure selection helper `selectActiveCameraIndex` (no World/WebGPU).
//   B. Integration through `extractFrame` -> `frame.cameras` ordering/length.
//
// Anchors:
//   plan-tasks.json w7: ActiveCamera selection logic unit test
//   requirements AC-12: per camera-entity-ID runtime selection, hard cut
//   requirements OOS-4: engine layer zero editor concept (selection by entity
//     ID, not editor/game semantics)
//   research Finding 4: engine selects camera by archetype first-hit, no
//     active-camera resource/marker/setter
//   plan-strategy D-2: engine renderer gains neutral by-entity-ID active
//     camera capability; resource absent -> first-hit fallback (backward compat)

import { World } from '@forgeax/engine-ecs';
import { ShaderRegistry, type ShaderRegistryDevice } from '@forgeax/engine-shader';
import { describe, expect, it } from 'vitest';

import { AssetRegistry } from '../asset-registry';
import { Camera, Transform } from '../components';
import { extractFrame } from '../render-system-extract';
import {
  ACTIVE_CAMERA_KEY,
  getActiveCamera,
  selectActiveCameraIndex,
  setActiveCamera,
} from '../systems/active-camera';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function identityTransform(): {
  posX: number;
  posY: number;
  posZ: number;
  quatX: number;
  quatY: number;
  quatZ: number;
  quatW: number;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
} {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    quatX: 0,
    quatY: 0,
    quatZ: 0,
    quatW: 1,
    scaleX: 1,
    scaleY: 1,
    scaleZ: 1,
  };
}

function makeAssets(): AssetRegistry {
  const mockDevice: ShaderRegistryDevice = {
    createShaderModule() {
      return {
        ok: true,
        value: undefined,
        unwrap: () => undefined,
        unwrapOr: (d: unknown) => d,
      } as unknown as ReturnType<ShaderRegistryDevice['createShaderModule']>;
    },
  };
  return new AssetRegistry(new ShaderRegistry({ device: mockDevice, manifestUrl: undefined }));
}

/** Spawn a Camera entity with a distinguishing fov so snapshots are identifiable. */
function spawnCamera(world: World, fov: number): number {
  const res = world.spawn(
    { component: Transform, data: identityTransform() },
    {
      component: Camera,
      data: {
        fov,
        aspect: 1.0,
        near: 0.1,
        far: 100.0,
        projection: 0,
        left: -1,
        right: 1,
        bottom: -1,
        top: 1,
      },
    },
  );
  expect(res.ok).toBe(true);
  return res.unwrap() as unknown as number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Layer A — pure selection helper
// ═══════════════════════════════════════════════════════════════════════════════

describe('w7 — selectActiveCameraIndex (pure)', () => {
  it('(1) active entity present in list -> returns its index', () => {
    expect(selectActiveCameraIndex([10, 20, 30], 20)).toBe(1);
    expect(selectActiveCameraIndex([10, 20, 30], 30)).toBe(2);
    expect(selectActiveCameraIndex([10, 20, 30], 10)).toBe(0);
  });

  it('(2) active entity undefined -> returns -1 (first-hit fallback)', () => {
    expect(selectActiveCameraIndex([10, 20, 30], undefined)).toBe(-1);
  });

  it('(3) active entity not in list -> returns -1 (first-hit fallback)', () => {
    expect(selectActiveCameraIndex([10, 20, 30], 999)).toBe(-1);
  });

  it('(4) single-element list + active points at it -> returns 0', () => {
    expect(selectActiveCameraIndex([42], 42)).toBe(0);
  });

  it('empty list -> -1 regardless of active', () => {
    expect(selectActiveCameraIndex([], 1)).toBe(-1);
    expect(selectActiveCameraIndex([], undefined)).toBe(-1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Layer A' — resource helpers
// ═══════════════════════════════════════════════════════════════════════════════

describe('w7 — getActiveCamera / setActiveCamera', () => {
  it('absent resource -> getActiveCamera returns undefined', () => {
    const world = new World();
    expect(getActiveCamera(world)).toBeUndefined();
  });

  it('setActiveCamera writes a resource readable by getActiveCamera', () => {
    const world = new World();
    setActiveCamera(world, 77);
    expect(getActiveCamera(world)).toEqual({ entity: 77 });
    expect(
      (world as unknown as { hasResource(k: string): boolean }).hasResource(ACTIVE_CAMERA_KEY),
    ).toBe(true);
  });

  it('setActiveCamera overwrites previous (idempotent last-write-wins)', () => {
    const world = new World();
    setActiveCamera(world, 1);
    setActiveCamera(world, 2);
    expect(getActiveCamera(world)).toEqual({ entity: 2 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Layer B — integration through extractFrame
// ═══════════════════════════════════════════════════════════════════════════════

describe('w7 — extractFrame ActiveCamera selection', () => {
  it('(2) no ActiveCamera + multiple cameras -> all cameras surface (first-hit fallback preserved)', () => {
    const world = new World();
    const assets = makeAssets();
    spawnCamera(world, 1.0);
    spawnCamera(world, 2.0);
    const frame = extractFrame(world, assets);
    // No selection -> existing behavior: both cameras flow through; record
    // stage fires multi-camera diagnostic + uses first hit. We assert extract
    // does NOT prune when there is no ActiveCamera.
    expect(frame.cameras.length).toBe(2);
  });

  it('(1) ActiveCamera pointing at 2nd camera -> only that camera surfaces', () => {
    const world = new World();
    const assets = makeAssets();
    spawnCamera(world, 1.0);
    const cam2 = spawnCamera(world, 2.0);
    setActiveCamera(world, cam2);
    const frame = extractFrame(world, assets);
    // Active camera resolved -> sole snapshot (no multi-camera diagnostic).
    expect(frame.cameras.length).toBe(1);
    expect(frame.cameras[0]?.fov).toBeCloseTo(2.0, 5);
  });

  it('(3) ActiveCamera pointing at non-existent entity -> fallback to first-hit (all cameras)', () => {
    const world = new World();
    const assets = makeAssets();
    spawnCamera(world, 1.0);
    spawnCamera(world, 2.0);
    setActiveCamera(world, 999999);
    const frame = extractFrame(world, assets);
    // Unresolvable -> behave as if no ActiveCamera (do not prune).
    expect(frame.cameras.length).toBe(2);
  });

  it('(4) single camera + ActiveCamera pointing at it -> behavior unchanged (one camera)', () => {
    const world = new World();
    const assets = makeAssets();
    const cam = spawnCamera(world, 1.5);
    setActiveCamera(world, cam);
    const frame = extractFrame(world, assets);
    expect(frame.cameras.length).toBe(1);
    expect(frame.cameras[0]?.fov).toBeCloseTo(1.5, 5);
  });

  it('(4-regression) single camera + NO ActiveCamera -> one camera (backward compat)', () => {
    const world = new World();
    const assets = makeAssets();
    spawnCamera(world, 0.9);
    const frame = extractFrame(world, assets);
    expect(frame.cameras.length).toBe(1);
    expect(frame.cameras[0]?.fov).toBeCloseTo(0.9, 5);
  });
});

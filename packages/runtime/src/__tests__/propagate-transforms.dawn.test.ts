// propagate-transforms.dawn.test.ts -- vitest dawn project (AC-04) CPU-only
// propagateTransforms behaviour test.
//
// Trigger: root vitest.config.ts `dawn` project (`*.dawn.test.ts` glob).
// Environment: node + setupFiles ./vitest.setup-webgpu.ts injects
//   globalThis.navigator.gpu (provided by dawn.node native binding).
//
// feat-20260601 M4: GlobalTransform is retired. propagateTransforms now writes
// the resolved world mat4 into the `Transform.world` column (column-major 16
// floats). Tests read that column via the ECS array view and assert the
// translation column (m[12,13,14]).
//
// Scope (w6 acceptanceCheck):
//   (a) root-only entity: Transform.world translation = local translation
//   (b) 2-level hierarchy: child.world = parent.world x child local
//   (c) stale ChildOf ref: Result.err(RhiError({ code: 'hierarchy-broken' }))
//   (d) N=3 deep chain: composition stacks correctly
//
// Although propagateTransforms is pure CPU code (no GPU access), the test is
// duplicated under the dawn layer so the AC-04 gate executes in both the
// browser GPU env and the dawn-node env -- matching plan-strategy §4 test
// matrix + requirements AC-04 two-layer coverage.

import type { EntityHandle } from '@forgeax/engine-ecs';
import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { ChildOf, Transform } from '../components/index';
import { propagateTransforms } from '../systems/propagate-transforms';

function identityTransformData() {
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

// Read the resolved world mat4 (column-major 16 floats) from the Transform
// world column array view. Translation lives in column 3 (m[12,13,14]).
function worldOf(world: World, entity: EntityHandle): Float32Array {
  const view = (
    world as unknown as {
      _getArrayView(e: EntityHandle, c: typeof Transform, f: string): Float32Array | undefined;
    }
  )._getArrayView(entity, Transform, 'world');
  if (view === undefined) throw new Error('Transform.world view missing');
  return view;
}

describe('propagate-transforms.dawn - root-down DFS + stale ChildOf fail-fast (AC-04)', () => {
  it('root entity: Transform.world translation = local translation (identity chain)', () => {
    const world = new World();
    const root = world
      .spawn({
        component: Transform,
        data: {
          posX: 3,
          posY: 4,
          posZ: 5,
          quatX: 0,
          quatY: 0,
          quatZ: 0,
          quatW: 1,
          scaleX: 2,
          scaleY: 2,
          scaleZ: 2,
        },
      })
      .unwrap();
    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);
    const w = worldOf(world, root);
    expect(w.length).toBe(16);
    expect(w[12]).toBeCloseTo(3, 5);
    expect(w[13]).toBeCloseTo(4, 5);
    expect(w[14]).toBeCloseTo(5, 5);
    // Scale 2 lands on the diagonal of the rotation/scale 3x3 block.
    expect(w[0]).toBeCloseTo(2, 5);
  });

  it('2-level hierarchy: child.world = parent.world x child local (translation compose)', () => {
    const world = new World();
    const root = world
      .spawn({
        component: Transform,
        data: {
          posX: 10,
          posY: 0,
          posZ: 0,
          quatX: 0,
          quatY: 0,
          quatZ: 0,
          quatW: 1,
          scaleX: 1,
          scaleY: 1,
          scaleZ: 1,
        },
      })
      .unwrap();
    const child = world
      .spawn(
        {
          component: Transform,
          data: {
            posX: 2,
            posY: 3,
            posZ: 0,
            quatX: 0,
            quatY: 0,
            quatZ: 0,
            quatW: 1,
            scaleX: 1,
            scaleY: 1,
            scaleZ: 1,
          },
        },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);
    const wc = worldOf(world, child);
    // parent translation (10,0,0) composed with child local translation
    // (2,3,0) and identity rotation/scale -> world position (12,3,0).
    expect(wc[12]).toBeCloseTo(12, 5);
    expect(wc[13]).toBeCloseTo(3, 5);
    expect(wc[14]).toBeCloseTo(0, 5);
    // Root world translation unaffected (identity chain writes).
    const wr = worldOf(world, root);
    expect(wr[12]).toBeCloseTo(10, 5);
  });

  it('N=3 deep hierarchy: grandchild position chains through two parent translations', () => {
    const world = new World();
    const root = world
      .spawn({
        component: Transform,
        data: {
          posX: 1,
          posY: 0,
          posZ: 0,
          quatX: 0,
          quatY: 0,
          quatZ: 0,
          quatW: 1,
          scaleX: 1,
          scaleY: 1,
          scaleZ: 1,
        },
      })
      .unwrap();
    const mid = world
      .spawn(
        {
          component: Transform,
          data: {
            posX: 2,
            posY: 0,
            posZ: 0,
            quatX: 0,
            quatY: 0,
            quatZ: 0,
            quatW: 1,
            scaleX: 1,
            scaleY: 1,
            scaleZ: 1,
          },
        },
        { component: ChildOf, data: { parent: root } },
      )
      .unwrap();
    const leaf = world
      .spawn(
        {
          component: Transform,
          data: {
            posX: 4,
            posY: 0,
            posZ: 0,
            quatX: 0,
            quatY: 0,
            quatZ: 0,
            quatW: 1,
            scaleX: 1,
            scaleY: 1,
            scaleZ: 1,
          },
        },
        { component: ChildOf, data: { parent: mid } },
      )
      .unwrap();
    const r = propagateTransforms(world);
    expect(r.ok).toBe(true);
    const wl = worldOf(world, leaf);
    // 1 + 2 + 4 = 7 along x-axis.
    expect(wl[12]).toBeCloseTo(7, 5);
  });

  it('stale ChildOf ref: Result.err(RhiError({ code: "hierarchy-broken" }))', () => {
    const world = new World();
    const ghost = world
      .spawn({
        component: Transform,
        data: identityTransformData(),
      })
      .unwrap();
    world.despawn(ghost).unwrap();
    const orphan = world
      .spawn(
        {
          component: Transform,
          data: identityTransformData(),
        },
        { component: ChildOf, data: { parent: ghost } },
      )
      .unwrap();
    void orphan;
    const r = propagateTransforms(world);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('hierarchy-broken');
    expect(r.error.hint.length).toBeGreaterThan(0);
    expect(r.error.expected.length).toBeGreaterThan(0);
  });
});

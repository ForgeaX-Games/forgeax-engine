import { mat4 } from '@forgeax/engine-math';
import { describe, expect, it } from 'vitest';
import {
  ShadowCasterOwnershipProjection,
  ShadowCasterOwnershipRebase,
} from '../gpu-driven/shadow-ownership';
import { shadowMembershipLookup } from '../record/shadow-ownership-index';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';

function caster(entityKey: number, x: number, materialHandle = 20): RenderableSnapshot {
  const world = mat4.identity(mat4.create());
  world[12] = x;
  return {
    worldId: 0,
    entityKey,
    assetHandle: 1,
    transform: { world },
    material: {} as never,
    materials: [],
    materialBindingSources: [],
    shadowCasterPasses: [
      {
        drawItemIndex: 0,
        materialHandle,
        passIndex: 1,
        materialShaderId: 'forgeax::default-shadow-caster',
        renderState: { cullMode: 'back' },
        gpuDrivenEligible: true,
      },
    ],
  } as RenderableSnapshot;
}

function shadowDispatch(renderableIndex: number): DispatchEntry {
  return { renderableIndex, tags: { LightMode: 'ShadowCaster' } } as unknown as DispatchEntry;
}

function frame(seconds: number, count = 64) {
  const renderables = Array.from({ length: count }, (_, index) =>
    caster(index + 1, Math.sin(seconds + index)),
  );
  const dispatch = renderables.map((_, index) => shadowDispatch(index));
  return { renderables, dispatch };
}

describe('steady-state ShadowCaster ownership', () => {
  it('keeps one ownership identity while only transforms move', () => {
    const projection = new ShadowCasterOwnershipProjection();
    const rebase = new ShadowCasterOwnershipRebase();
    const worlds = [{} as never];
    const stableWorldKeys = [7];
    const first = frame(0);
    const owned = projection.project(first.renderables, first.dispatch);
    const rebased = rebase.rebase(
      worlds,
      stableWorldKeys,
      owned.entityKeys,
      owned.drawKeys,
      owned.membership,
    );
    const lookup = shadowMembershipLookup(rebased.membership ?? []);
    expect(owned.membership).toHaveLength(64);
    expect(projection.buildCount()).toBe(1);

    for (let step = 1; step <= 120; step += 1) {
      const next = frame(step / 60);
      const again = projection.project(next.renderables, next.dispatch);
      expect(again).toBe(owned);
      const rebasedAgain = rebase.rebase(
        worlds,
        [...stableWorldKeys],
        again.entityKeys,
        again.drawKeys,
        again.membership,
      );
      expect(rebasedAgain).toBe(rebased);
      expect(shadowMembershipLookup(rebasedAgain.membership ?? [])).toBe(lookup);
    }
    expect(projection.buildCount()).toBe(1);
  });

  it('rebuilds on every ownership fact and on stable world key changes', () => {
    const projection = new ShadowCasterOwnershipProjection();
    const rebase = new ShadowCasterOwnershipRebase();
    const base = frame(0, 4);
    const owned = projection.project(base.renderables, base.dispatch);

    const material = frame(0, 4);
    material.renderables[2] = caster(3, 0, 21);
    const byMaterial = projection.project(material.renderables, material.dispatch);
    expect(byMaterial).not.toBe(owned);
    expect(byMaterial.membership[2]?.materialHandle).toBe(21);

    const hidden = frame(0, 4);
    hidden.renderables[2] = { ...caster(3, 0, 21), authorVisible: false };
    const byVisibility = projection.project(hidden.renderables, hidden.dispatch);
    expect(byVisibility).not.toBe(byMaterial);
    expect(byVisibility.membership).toHaveLength(3);

    const reordered = frame(0, 4);
    reordered.renderables[2] = { ...caster(3, 0, 21), authorVisible: false };
    reordered.dispatch.reverse();
    expect(projection.project(reordered.renderables, reordered.dispatch)).not.toBe(byVisibility);

    const removed = frame(0, 3);
    expect(projection.project(removed.renderables, removed.dispatch).membership).toHaveLength(3);
    expect(projection.buildCount()).toBe(5);

    const current = projection.project(removed.renderables, removed.dispatch);
    const worlds = [{} as never];
    const first = rebase.rebase(
      worlds,
      [1],
      current.entityKeys,
      current.drawKeys,
      current.membership,
    );
    const moved = rebase.rebase(
      worlds,
      [2],
      current.entityKeys,
      current.drawKeys,
      current.membership,
    );
    expect(moved).not.toBe(first);
    expect(moved.membership?.[0]?.worldEntity).not.toBe(first.membership?.[0]?.worldEntity);
  });
});

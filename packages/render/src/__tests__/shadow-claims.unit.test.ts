import { describe, expect, it } from 'vitest';
import { gpuDrivenShadowDrawKey } from '../extract/gpu-driven';
import { buildShadowMembershipIndex, ShadowClaimTable } from '../gpu-driven/shadow-claims';
import { worldEntityKey } from '../record/frame-snapshot';
import type { RenderableSnapshot, ShadowCasterMembership } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';

type Slot = PersistentGpuDrivenState['slots'][number];

function slot(entityKey: number, materialHandle: number): Slot {
  const snapshot = {
    worldId: 0,
    entityKey,
    material: { materialHandle },
    materials: [{ materialHandle }],
    gpuDrivenDraws: [{ drawItemIndex: 0, materialSlot: 0 }],
  } as unknown as RenderableSnapshot;
  return { slot: entityKey, generation: 0, snapshot } as unknown as Slot;
}

function membership(
  entityKey: number,
  materialHandle: number,
  extra: Partial<ShadowCasterMembership> = {},
): ShadowCasterMembership {
  return {
    worldEntity: worldEntityKey(0, entityKey),
    renderableIndex: entityKey,
    drawItemIndex: 0,
    materialHandle,
    passIndex: 1,
    renderState: { cullMode: 'back' },
    gpuDrivenEligible: true,
    ...extra,
  } as ShadowCasterMembership;
}

function table(rows: readonly ShadowCasterMembership[]): ShadowClaimTable {
  return new ShadowClaimTable(undefined, rows, buildShadowMembershipIndex(undefined, rows));
}

const candidate = (primitiveIndex: number) => ({ primitiveIndex, drawItemIndex: 0 }) as never;

describe('ShadowClaimTable', () => {
  it('shares one frozen claim across every instance candidate of a snapshot', () => {
    const owner = slot(1, 20);
    const claims = table([membership(1, 20)]);
    const first = claims.claim(owner, candidate(1));
    expect(first).toEqual({
      keys: [gpuDrivenShadowDrawKey(worldEntityKey(0, 1), 20, 0, 1)],
      compatible: true,
      entry: expect.objectContaining({ materialHandle: 20 }),
    });
    expect(Object.isFrozen(first)).toBe(true);
    for (let instance = 0; instance < 4096; instance++) {
      expect(claims.claim(owner, candidate(1))).toBe(first);
    }
  });

  it('keeps unclaimed, ambiguous and CPU-lane draws off the GPU lane', () => {
    expect(table([]).claim(slot(1, 20), candidate(1))).toMatchObject({
      keys: [],
      compatible: false,
    });
    expect(
      table([membership(1, 20), membership(1, 20, { passIndex: 2 })]).claim(
        slot(1, 20),
        candidate(1),
      ).compatible,
    ).toBe(false);
    expect(
      table([membership(1, 20, { cpuReason: 'unsupported-render-state' } as never)]).claim(
        slot(1, 20),
        candidate(1),
      ),
    ).toMatchObject({ keys: [expect.any(String)], compatible: false });
    expect(
      table([membership(1, 20, { gpuDrivenEligible: false })]).claim(slot(1, 20), candidate(1))
        .compatible,
    ).toBe(false);
  });

  it('recomputes for a new snapshot identity of the same slot', () => {
    const claims = table([membership(1, 20)]);
    const before = claims.claim(slot(1, 20), candidate(1));
    const rematerialized = claims.claim(slot(1, 21), candidate(1));
    expect(before.compatible).toBe(true);
    expect(rematerialized).not.toBe(before);
    expect(rematerialized.compatible).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildMaterialSlotPlan,
  findRenderablePrefixForSlotCapacity,
  materialSlotCountForPrefix,
} from '../material-slot-plan';

describe('material slot plan', () => {
  it('interns repeated snapshot identities across renderables', () => {
    const a = {};
    const b = {};
    const c = {};
    expect(
      buildMaterialSlotPlan([
        [a, b],
        [a, c],
        [b, a],
      ]),
    ).toEqual({
      slotIndices: [
        [0, 1],
        [0, 2],
        [1, 0],
      ],
      slots: [a, b, c],
      slotOwners: [0, 0, 1],
    });
  });

  it('does not merge equal-looking snapshots with distinct identities', () => {
    expect(buildMaterialSlotPlan([[{}], [{}]])).toMatchObject({
      slotIndices: [[0], [1]],
      slots: [{}, {}],
      slotOwners: [0, 1],
    });
  });

  it('truncates only at complete mesh and material prefixes', () => {
    const indices = [[0], [1, 2, 3], [0, 4], [5, 6, 7, 8]];
    expect(findRenderablePrefixForSlotCapacity(indices, 3)).toBe(1);
    expect(findRenderablePrefixForSlotCapacity(indices, 5)).toBe(3);
    expect(materialSlotCountForPrefix(indices, 3)).toBe(5);
  });
});

import { describe, expect, it } from 'vitest';
import {
  buildDispatchPlan,
  buildMaterialSlotPlan,
  findRenderablePrefixForSlotCapacity,
  materialSlotCountForPrefix,
} from '../frame';

function validatedRow(renderableIndex: number) {
  return {
    source: {
      material: { materialShaderId: 'forgeax::default-unlit' },
      materials: [{ materialShaderId: 'forgeax::default-unlit' }],
    },
    mesh: {},
    renderableIndex,
    renderState: undefined,
    stencilReference: undefined,
  } as never;
}

function ceilingInternals(slotCount: number) {
  return {
    growMeshSsbo: () => ({
      ok: false as const,
      code: 'mesh-ssbo-ceiling-reached' as const,
      degradedToSlotCount: slotCount,
    }),
    meshSsboState: { slotCount },
  } as never;
}

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

  it('separates per-object probe/pass bindings while interning the same resource class', () => {
    const material = {};
    expect(
      buildMaterialSlotPlan([[material], [material], [material]], (_, owner) =>
        owner === 1 ? 'probe:1' : 'probe:0',
      ),
    ).toEqual({ slotIndices: [[0], [1], [0]], slots: [material, material], slotOwners: [0, 1] });
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

  it('keeps retained shadow rows inside the ceiling when the primary view is empty', () => {
    const shadowRows = [validatedRow(0), validatedRow(1), validatedRow(2)];
    const plan = buildDispatchPlan(ceilingInternals(2), [], [], [], shadowRows);

    expect(plan.validatedOrdered).toHaveLength(0);
    expect(plan.shadowValidatedOrdered).toEqual(shadowRows.slice(0, 2));
    expect(plan.validatedOrdered.length + plan.shadowValidatedOrdered.length).toBeLessThanOrEqual(
      2,
    );
  });

  it('reserves the primary rows before retained shadow rows on a mixed ceiling', () => {
    const primaryRows = [validatedRow(0), validatedRow(1)];
    const shadowRows = [validatedRow(2), validatedRow(3)];
    const plan = buildDispatchPlan(ceilingInternals(3), primaryRows, [], [], shadowRows);

    expect(plan.validatedOrdered).toEqual(primaryRows);
    expect(plan.shadowValidatedOrdered).toEqual(shadowRows.slice(0, 1));
    expect(plan.validatedOrdered.length + plan.shadowValidatedOrdered.length).toBeLessThanOrEqual(
      3,
    );
  });
});

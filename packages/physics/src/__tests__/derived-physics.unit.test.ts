import { describe, expect, it } from 'vitest';
import {
  cloneDerivedPhysicsInput,
  normalizeVoxelShapeInput,
  preserveCenterOfMassVelocity,
  validateMassProperties,
} from '../derived-physics';

const shape = (id = 'left', voxelSize: readonly [number, number, number] = [1, 1, 1]) => ({
  id,
  revision: 1,
  cells: new Int32Array([0, 0, 0, -1, 0, 0]),
  voxelSize,
});

describe('derived physics data contract', () => {
  it('copies cells and normalizes a local orientation before native preparation', () => {
    const input = shape();
    const result = normalizeVoxelShapeInput({ ...input, rotation: [0, 0, 0, 2] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    input.cells[0] = 99;
    expect(result.value.cells[0]).toBe(0);
    expect(result.value.rotation[3]).toBeCloseTo(1);
  });

  it('rejects mismatched voxel seams and degenerate explicit mass', () => {
    const seam = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'body:7',
      shapes: [shape('left'), shape('right', [2, 1, 1])],
      seams: [{ shapeA: 'left', shapeB: 'right', offset: [1, 0, 0] }],
    });
    expect(seam.ok).toBe(false);
    if (!seam.ok) expect(seam.error.code).toBe('derived-seam-invalid');

    const mass = validateMassProperties({
      mode: 'explicit',
      mass: 1,
      centerOfMass: [0, 0, 0],
      principalInertia: [1, 0, 1],
    });
    expect(mass.ok).toBe(false);
    if (!mass.ok) expect(mass.error.code).toBe('derived-mass-invalid');
  });

  it('requires seam origin/grid agreement while accepting quaternion sign equivalence', () => {
    const aligned = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'body:7',
      shapes: [
        { ...shape('left'), origin: [0, 0, 0], rotation: [0, 0, 0, 1] },
        { ...shape('right'), origin: [2, 0, 0], rotation: [0, 0, 0, -1] },
      ],
      seams: [{ shapeA: 'left', shapeB: 'right', offset: [2, 0, 0] }],
    });
    expect(aligned.ok).toBe(true);

    const offsetMismatch = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'body:7',
      shapes: [
        { ...shape('left'), origin: [0, 0, 0] },
        { ...shape('right'), origin: [2, 0, 0] },
      ],
      seams: [{ shapeA: 'left', shapeB: 'right', offset: [1, 0, 0] }],
    });
    expect(offsetMismatch.ok).toBe(false);
    if (!offsetMismatch.ok) expect(offsetMismatch.error.code).toBe('derived-seam-invalid');

    const rotationMismatch = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'body:7',
      shapes: [
        { ...shape('left'), origin: [0, 0, 0] },
        { ...shape('right'), origin: [2, 0, 0], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] },
      ],
      seams: [{ shapeA: 'left', shapeB: 'right', offset: [2, 0, 0] }],
    });
    expect(rotationMismatch.ok).toBe(false);
    if (!rotationMismatch.ok) expect(rotationMismatch.error.code).toBe('derived-seam-invalid');
  });

  it('checks seam offsets after rotating the local delta into the shared grid frame', () => {
    const quarterTurnZ: readonly [number, number, number, number] = [
      0,
      0,
      Math.SQRT1_2,
      Math.SQRT1_2,
    ];
    const aligned = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'body:7',
      shapes: [
        { ...shape('left'), origin: [0, 0, 0], rotation: quarterTurnZ },
        { ...shape('right'), origin: [0, 1, 0], rotation: quarterTurnZ },
      ],
      seams: [{ shapeA: 'left', shapeB: 'right', offset: [1, 0, 0] }],
    });
    expect(aligned.ok).toBe(true);

    const misaligned = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'body:7',
      shapes: [
        { ...shape('left'), origin: [0, 0, 0], rotation: quarterTurnZ },
        { ...shape('right'), origin: [1, 0, 0], rotation: quarterTurnZ },
      ],
      seams: [{ shapeA: 'left', shapeB: 'right', offset: [1, 0, 0] }],
    });
    expect(misaligned.ok).toBe(false);
    if (!misaligned.ok) expect(misaligned.error.code).toBe('derived-seam-invalid');
  });

  it('bounds candidate counts and estimated staged bytes', () => {
    const tooManyShapes = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'body:7',
      shapes: Array.from({ length: 65 }, (_, index) => shape(`shape-${index}`)),
    });
    expect(tooManyShapes.ok).toBe(false);
    if (!tooManyShapes.ok) {
      expect(tooManyShapes.error.code).toBe('derived-candidate-budget-exceeded');
      expect(tooManyShapes.error.detail.actual).toBe(65);
    }

    const tooManyBytes = cloneDerivedPhysicsInput({
      entity: 7,
      revision: 1,
      sourceKey: 'body:7',
      shapes: [
        {
          id: 'large',
          revision: 1,
          cells: new Int32Array(262_144 * 3),
          voxelSize: [1, 1, 1],
        },
      ],
    });
    expect(tooManyBytes.ok).toBe(false);
    if (!tooManyBytes.ok) expect(tooManyBytes.error.code).toBe('derived-candidate-budget-exceeded');
  });

  it('preserves linear velocity at a moved center of mass and leaves angular velocity intact', () => {
    expect(preserveCenterOfMassVelocity([1, 2, 3], [0, 0, 2], [0, 0, 0], [0, 1, 0])).toEqual([
      -1, 2, 3,
    ]);
  });
});

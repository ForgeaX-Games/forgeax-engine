import { World } from '@forgeax/engine-ecs';
import {
  extractFrame,
  extractFrames,
  prepareExtractContext,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render/internal';
import { ChildOf, registerPropagateTransforms, Transform } from '@forgeax/engine-scene';
import { describe, expect, it } from 'vitest';

function transform(pos: [number, number, number]) {
  return {
    pos,
    quat: [0, 0, 0, 1] as [number, number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  };
}

function makeWorld() {
  const world = new World();
  registerPropagateTransforms(world);
  const parent = world
    .spawn(
      { component: Transform, data: transform([1, 0, 0]) },
      { component: Visibility, data: { state: VisibilityStateValue.hidden } },
    )
    .unwrap();
  const child = world
    .spawn(
      { component: Transform, data: transform([2, 0, 0]) },
      { component: ChildOf, data: { parent } },
      { component: Visibility, data: { state: VisibilityStateValue.visible } },
    )
    .unwrap();
  return { world, parent, child };
}

describe('visibility extract orchestration', () => {
  it('refreshes hierarchy and visibility from the final World state', () => {
    const { world, parent, child } = makeWorld();
    world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    world.update(0).unwrap();

    const frame = extractFrames([world], 0);
    const snapshot = frame.visibilitySnapshots[0];
    expect(snapshot?.get(parent)?.effective).toBe('visible');
    expect(snapshot?.get(child)?.effective).toBe('visible');
    expect(world.get(child, Transform).unwrap().world[12]).toBeCloseTo(3);
  });

  it('keeps renderer extraction read-only over derived Transform.world', () => {
    const { world, parent, child } = makeWorld();
    world.update(0).unwrap();
    const before = [...world.get(child, Transform).unwrap().world];
    const internal = world as unknown as {
      _getMutationEpoch(): number;
      _getStructureEpoch(): number;
    };

    world.set(parent, Transform, { pos: [9, 0, 0] }).unwrap();
    const mutationBeforeExtract = internal._getMutationEpoch();
    const structureBeforeExtract = internal._getStructureEpoch();
    extractFrames([world], 0);

    expect([...world.get(child, Transform).unwrap().world]).toEqual(before);
    expect(internal._getMutationEpoch()).toBe(mutationBeforeExtract);
    expect(internal._getStructureEpoch()).toBe(structureBeforeExtract);
    world.update(0).unwrap();
    expect(world.get(child, Transform).unwrap().world[12]).toBeCloseTo(11);
  });

  it('keeps direct prepared-kernel output aligned with extractFrames output', () => {
    const { world, child } = makeWorld();
    const merged = extractFrames([world], 0);
    const prepared = prepareExtractContext(world);
    const direct = extractFrame(world, prepared);

    expect(direct.cameras).toEqual(merged.cameras);
    expect(direct.dispatch).toEqual(merged.dispatch);
    expect(prepared.visibility.get(child)?.effective).toBe('visible');
  });

  it('does not reuse a prior visibility result across repeated extracts', () => {
    const { world, parent } = makeWorld();
    const first = extractFrames([world], 0);
    expect(first.visibilitySnapshots[0]?.get(parent)?.effective).toBe('hidden');

    world.set(parent, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    const second = extractFrames([world], 0);
    expect(second.visibilitySnapshots[0]?.get(parent)?.effective).toBe('visible');
  });
});

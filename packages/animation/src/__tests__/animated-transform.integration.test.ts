import { type EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import type { AnimationClip } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { AnimationPlayer } from '../animation-player';
import { defineAnimationGraph } from '../graph/define-animation-graph';
import { animationPlugin } from '../plugin';

function channel(
  targetPath: readonly string[],
  property: 'translation' | 'rotation' | 'scale',
  output: number[],
  input: number[] = [0, 1],
) {
  return {
    targetPath,
    property,
    sampler: {
      input: new Float32Array(input),
      output: new Float32Array(output),
      interpolation: 'LINEAR' as const,
    },
  };
}

describe('AnimationPlayer targetRoot drives named scene Transforms', () => {
  it('plays translation, rotation, and scale channels through the graph path', async () => {
    const world = new World();
    expect((await animationPlugin().build(world)).ok).toBe(true);

    const planet = world
      .spawn({ component: Transform, data: {} }, { component: Name, data: { value: 'planet' } })
      .unwrap() as EntityHandle;
    const orbitController = world
      .spawn(
        { component: Transform, data: {} },
        { component: Name, data: { value: 'orbit_controller' } },
        { component: ChildOf, data: { parent: planet } },
      )
      .unwrap() as EntityHandle;
    const satellite = world
      .spawn(
        { component: Transform, data: {} },
        { component: Name, data: { value: 'satellite' } },
        { component: ChildOf, data: { parent: orbitController } },
      )
      .unwrap() as EntityHandle;

    const clip: AnimationClip = {
      kind: 'animation-clip',
      duration: 1,
      channels: [
        channel(['planet'], 'translation', [0, 0, 0, 2, 0, 0]),
        channel(['planet', 'orbit_controller'], 'rotation', [
          0,
          0,
          0,
          1,
          0,
          Math.SQRT1_2,
          0,
          Math.SQRT1_2,
        ]),
        channel(['planet', 'orbit_controller', 'satellite'], 'scale', [1, 1, 1, 2, 2, 2]),
      ],
    };
    const clipHandle = world.allocSharedRef('AnimationClip', clip);
    const graph = defineAnimationGraph((builder) => builder.clip(clipHandle));
    expect(graph.ok).toBe(true);
    if (!graph.ok) return;
    const graphHandle = world.allocSharedRef('AnimationGraph', graph.value);

    world.addComponent(planet, {
      component: AnimationPlayer,
      data: { graph: graphHandle, nodeSpeeds: [1], targetRoot: planet, looping: true },
    });

    for (let i = 0; i < 5; i++) world.update(0.1);

    const planetTransform = world.get(planet, Transform).unwrap();
    const orbitTransform = world.get(orbitController, Transform).unwrap();
    const satelliteTransform = world.get(satellite, Transform).unwrap();
    expect(planetTransform.pos[0]).toBeCloseTo(1, 5);
    expect(orbitTransform.quat[1]).toBeCloseTo(0.382683, 4);
    expect(orbitTransform.quat[3]).toBeCloseTo(0.92388, 4);
    expect(satelliteTransform.scale[0]).toBeCloseTo(1.5, 5);
    expect(satelliteTransform.scale[1]).toBeCloseTo(1.5, 5);
    expect(satelliteTransform.scale[2]).toBeCloseTo(1.5, 5);
  });
});

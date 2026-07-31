import { AnimationPlayer, defineAnimationGraph } from '@forgeax/engine-animation';
import { HANDLE_CUBE, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, World } from '@forgeax/engine-ecs';
import { ChildOf, Name, Transform } from '@forgeax/engine-scene';
import { Camera, DirectionalLight, Materials, MeshFilter, MeshRenderer, perspective } from '@forgeax/engine-render';
import type { AnimationChannel, AnimationClip, MaterialAsset } from '@forgeax/engine-types';
import { quat } from '@forgeax/engine-math';

const channel = (
  targetPath: readonly string[],
  property: AnimationChannel['property'],
  input: number[],
  output: number[],
): AnimationChannel => ({
  targetPath,
  property,
  sampler: {
    input: new Float32Array(input),
    output: new Float32Array(output),
    interpolation: 'LINEAR',
  },
});

export interface AnimatedTransformState {
  readonly planet: EntityHandle;
  readonly orbitController: EntityHandle;
  readonly satellite: EntityHandle;
}

export function buildAnimatedTransformWorld(world: World): AnimatedTransformState {
  const planetMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.18, 0.45, 0.95, 1] }),
  );
  const satelliteMaterial = world.allocSharedRef<'MaterialAsset', MaterialAsset>(
    'MaterialAsset',
    Materials.standard({ baseColor: [0.95, 0.35, 0.12, 1] }),
  );

  const planet = world
    .spawn(
      { component: Transform, data: { pos: [1, 0, 1], scale: [1.2, 1.2, 1.2] } },
      { component: Name, data: { value: 'planet' } },
      { component: MeshFilter, data: { assetHandle: HANDLE_SPHERE } },
      { component: MeshRenderer, data: { materials: [planetMaterial] } },
    )
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
      { component: Transform, data: { pos: [2.8, 0, 0], scale: [0.55, 0.55, 0.55] } },
      { component: Name, data: { value: 'satellite' } },
      { component: ChildOf, data: { parent: orbitController } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [satelliteMaterial] } },
    )
    .unwrap() as EntityHandle;

  const clip: AnimationClip = {
    kind: 'animation-clip',
    duration: 4,
    channels: [
      channel(
        ['planet'],
        'translation',
        [0, 1, 2, 3, 4],
        [1, 0, 1, -1, 0, 1, -1, 0, -1, 1, 0, -1, 1, 0, 1],
      ),
      channel(
        ['planet', 'orbit_controller'],
        'rotation',
        [0, 1, 2, 3, 4],
        [0, 0, 0, 1, 0, 0.3826834, 0, 0.9238795, 0, 0.7071068, 0, 0.7071068, 0, 0.9238795, 0, 0.3826834, 0, 1, 0, 0],
      ),
      channel(
        ['planet', 'orbit_controller', 'satellite'],
        'scale',
        [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4],
        [0.8, 0.8, 0.8, 1.2, 1.2, 1.2, 0.8, 0.8, 0.8, 1.2, 1.2, 1.2, 0.8, 0.8, 0.8, 1.2, 1.2, 1.2, 0.8, 0.8, 0.8, 1.2, 1.2, 1.2, 0.8, 0.8, 0.8],
      ),
    ],
  };
  const clipHandle = world.allocSharedRef('AnimationClip', clip);
  const graphResult = defineAnimationGraph((builder) => builder.clip(clipHandle));
  if (!graphResult.ok) throw new Error(`[animated-transform] graph build failed: ${graphResult.error.code}`);
  const graphHandle = world.allocSharedRef('AnimationGraph', graphResult.value);
  world.addComponent(planet, {
    component: AnimationPlayer,
    data: { graph: graphHandle, nodeSpeeds: [1], targetRoot: planet, looping: true },
  });

  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.8, -0.5], color: [1, 1, 1], intensity: 3, castShadow: false },
  });
  const eye: [number, number, number] = [0, 3.5, 14];
  world.spawn(
    {
      component: Transform,
      data: { pos: eye, quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]) },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 100 }) },
  );

  return { planet, orbitController, satellite };
}

export function readAnimatedTransformState(world: World, state: AnimatedTransformState) {
  const snapshot = (entity: EntityHandle) => {
    const transform = world.get(entity, Transform).unwrap();
    return {
      pos: new Float32Array(transform.pos),
      quat: new Float32Array(transform.quat),
      scale: new Float32Array(transform.scale),
    };
  };
  return {
    planet: snapshot(state.planet),
    orbitController: snapshot(state.orbitController),
    satellite: snapshot(state.satellite),
  };
}

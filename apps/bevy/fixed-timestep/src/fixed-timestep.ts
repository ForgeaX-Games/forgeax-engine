import { FixedUpdate, Update, type World } from '@forgeax/engine-ecs';
import { quat } from '@forgeax/engine-math';
import { Camera, perspective, Transform } from '@forgeax/engine-runtime';

export interface FixedTimestepState {
  updateFrames: number;
  fixedUpdateFrames: number;
}

export function buildFixedTimestepWorld(world: World): { getState: () => FixedTimestepState } {
  const state: FixedTimestepState = { updateFrames: 0, fixedUpdateFrames: 0 };

  world.addSystem(Update, {
    name: 'frame-update',
    queries: [],
    fn: () => {
      state.updateFrames += 1;
    },
  });

  world.addSystem(FixedUpdate, {
    name: 'fixed-update',
    queries: [],
    fn: () => {
      state.fixedUpdateFrames += 1;
    },
  });

  const eye = [-2, 2.5, 5];
  world.spawn(
    {
      component: Transform,
      data: {
        pos: eye,
        quat: quat.fromLookAt(quat.create(), eye, [0, 0, 0], [0, 1, 0]),
        scale: [1, 1, 1],
      },
    },
    { component: Camera, data: perspective({ fov: Math.PI / 4, aspect: 16 / 9 }) },
  );

  return { getState: () => state };
}

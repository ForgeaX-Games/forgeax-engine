import { FixedUpdate, Update, type World } from '@forgeax/engine-ecs';

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

  return { getState: () => state };
}
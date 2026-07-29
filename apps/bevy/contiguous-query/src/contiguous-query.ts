import { HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import {
  Entity,
  Time,
  Update,
  World,
  createQueryState,
  defineComponent,
  queryRunContiguous,
} from '@forgeax/engine-ecs';
import { Camera, Materials, MeshFilter, MeshRenderer, orthographic } from '@forgeax/engine-render';
import type { MaterialAsset } from '@forgeax/engine-runtime';
import { Transform } from '@forgeax/engine-scene';

const HEALTH_COUNT = 32;
const Health = defineComponent('ContiguousQueryHealth', { value: 'f32' });
const HealthDecay = defineComponent('ContiguousQueryHealthDecay', { factor: 'f32' });
const healthQuery = createQueryState<
  readonly [typeof Health, typeof HealthDecay, typeof Entity],
  readonly []
>({ with: [Health, HealthDecay, Entity] });

export interface ContiguousQueryState {
  elapsed: number;
  contiguousSupported: boolean;
  contiguousCalls: number;
  decayPasses: number;
  rows: number;
  lengthsEqual: boolean;
  initialHealth: number;
  currentHealth: number;
}

export interface ContiguousQuerySnapshot extends ContiguousQueryState {}

export function buildContiguousQueryWorld(world: World): ContiguousQueryState {
  const state: ContiguousQueryState = {
    elapsed: 0,
    contiguousSupported: false,
    contiguousCalls: 0,
    decayPasses: 0,
    rows: 0,
    lengthsEqual: true,
    initialHealth: 100,
    currentHealth: 100,
  };
  const material = world.allocSharedRef<'MaterialAsset', MaterialAsset>('MaterialAsset', Materials.unlit([0.9, 0.35, 0.1, 1]));

  for (let index = 0; index < HEALTH_COUNT; index++) {
    const column = index % 8;
    const row = Math.floor(index / 8);
    world.spawn(
      { component: Transform, data: { pos: [column * 120 - 420, row * 120 - 180, 0], quat: [0, 0, 0, 1], scale: [48, 48, 1] } },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [material] } },
      { component: Health, data: { value: state.initialHealth } },
      { component: HealthDecay, data: { factor: 0.98 } },
    ).unwrap();
  }
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 100], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: orthographic({ left: -640, right: 640, bottom: -360, top: 360, near: 0.1, far: 2000 }) },
  );

  world.addSystem(Update, {
    name: 'contiguous-query-health-decay',
    queries: [],
    fn: (world) => {
      state.elapsed += world.getResource(Time).delta;
      state.rows = 0;
      state.contiguousSupported = queryRunContiguous(healthQuery, world, (bundle) => {
        state.contiguousCalls += 1;
        state.rows = bundle.Entity.self.length;
        state.lengthsEqual = state.lengthsEqual &&
          bundle.ContiguousQueryHealth.value.length === bundle.ContiguousQueryHealthDecay.factor.length &&
          bundle.ContiguousQueryHealth.value.length === bundle.Entity.self.length;
        for (let index = 0; index < bundle.Entity.self.length; index++) {
          const health = bundle.ContiguousQueryHealth.value[index] ?? 0;
          const decay = bundle.ContiguousQueryHealthDecay.factor[index] ?? 0;
          bundle.ContiguousQueryHealth.value[index] = health * decay;
          if (index === 0) state.currentHealth = bundle.ContiguousQueryHealth.value[index] ?? 0;
        }
      });
      state.decayPasses += 1;
    },
  }).unwrap();

  return state;
}

export function readContiguousQueryState(state: ContiguousQueryState): ContiguousQuerySnapshot {
  return { ...state };
}

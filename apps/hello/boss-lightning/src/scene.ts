import type { EntityHandle, World } from '@forgeax/engine-ecs';
import {
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  PointLight,
  perspective,
} from '@forgeax/engine-render';
import { HANDLE_CUBE, HANDLE_CYLINDER, HANDLE_SPHERE } from '@forgeax/engine-assets-runtime';
import { ChildOf, Transform } from '@forgeax/engine-scene';
import type { Handle } from '@forgeax/engine-types';

export interface BossSceneMaterials {
  readonly body: Handle<'MaterialAsset', 'shared'>;
  readonly accent: Handle<'MaterialAsset', 'shared'>;
  readonly mouth: Handle<'MaterialAsset', 'shared'>;
  readonly groundWarning: Handle<'MaterialAsset', 'shared'>;
  readonly strike: Handle<'MaterialAsset', 'shared'>;
}

export interface BossScene {
  readonly player: EntityHandle;
  readonly body: EntityHandle;
  readonly head: EntityHandle;
  readonly mouthGlow: EntityHandle;
  readonly mouthJoint: EntityHandle;
  readonly camera: EntityHandle;
  readonly groundWarning: EntityHandle;
  readonly strike: EntityHandle;
}

type Position = [number, number, number];
type Scale = [number, number, number];

function spawnMesh(
  world: World,
  mesh: Handle<'MeshAsset', 'shared'>,
  material: Handle<'MaterialAsset', 'shared'>,
  pos: Position,
  scale: Scale,
  parent?: EntityHandle,
): EntityHandle {
  const transform = { component: Transform, data: { pos, scale } };
  const renderable = [
    { component: MeshFilter, data: { assetHandle: mesh } },
    { component: MeshRenderer, data: { materials: [material] } },
  ] as const;
  if (parent === undefined) return world.spawn(transform, ...renderable).unwrap();
  return world
    .spawn(transform, { component: ChildOf, data: { parent } }, ...renderable)
    .unwrap();
}

export function createBossScene(
  world: World,
  materials: BossSceneMaterials,
): BossScene {
  const player = world
    .spawn({ component: Transform, data: { pos: [-0.85, -0.3, 0] } })
    .unwrap();
  const body = spawnMesh(world, HANDLE_SPHERE, materials.body, [0, 0.8, 0], [1.25, 1.4, 0.85], player);
  const head = spawnMesh(world, HANDLE_SPHERE, materials.accent, [0, 2.05, 0.04], [1.02, 0.86, 0.72], player);
  spawnMesh(world, HANDLE_CYLINDER, materials.accent, [-0.72, 2.72, 0], [0.2, 0.72, 0.2], player);
  spawnMesh(world, HANDLE_CYLINDER, materials.accent, [0.72, 2.72, 0], [0.2, 0.72, 0.2], player);
  const mouthJoint = world
    .spawn(
      { component: Transform, data: { pos: [0, 1.35, 0.72] } },
      { component: ChildOf, data: { parent: player } },
    )
    .unwrap();
  const mouthGlow = spawnMesh(
    world,
    HANDLE_SPHERE,
    materials.mouth,
    [0, 1.35, 0.72],
    [0.25, 0.25, 0.18],
    player,
  );
  world.addComponent(mouthGlow, {
    component: PointLight,
    data: { color: [0.12, 0.35, 1], intensity: 18, range: 5 },
  }).unwrap();
  const camera = world
    .spawn(
      { component: Transform, data: { pos: [0, 1.35, 8.5] } },
      {
        component: Camera,
        data: {
          ...perspective({ fov: Math.PI / 3, aspect: 16 / 9 }),
          tonemap: 1,
          exposure: 1.15,
          bloom: 1,
          bloomThreshold: 0.7,
          bloomIntensity: 1.35,
          bloomBlurRadius: 3,
          clearColor: [0.008, 0.012, 0.04, 1],
        },
      },
    )
    .unwrap();
  world.spawn({
    component: DirectionalLight,
    data: { direction: [-0.4, -0.8, -0.5], color: [0.5, 0.62, 1], intensity: 2.2, castShadow: false },
  }).unwrap();
  const groundWarning = spawnMesh(world, HANDLE_CUBE, materials.groundWarning, [0.25, -1.15, 0], [3.5, 0.05, 1.8]);
  const strike = spawnMesh(world, HANDLE_CUBE, materials.strike, [1.55, 0.65, 0], [0.14, 1.75, 0.14]);
  return { player, body, head, mouthGlow, mouthJoint, camera, groundWarning, strike };
}

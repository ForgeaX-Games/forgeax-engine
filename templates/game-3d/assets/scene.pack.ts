import { quat } from '@forgeax/engine/math';
import type { ScriptablePackDefinition } from '@forgeax/engine/pack/source';
import {
  CharacterController,
  Collider,
  ColliderShapeValue,
  RigidBody,
  RigidBodyTypeValue,
} from '@forgeax/engine/physics';
import {
  ANTIALIAS_FXAA,
  Camera,
  DirectionalLight,
  MeshFilter,
  MeshRenderer,
  perspective,
  PointLight,
  SKYBOX_MODE_CUBEMAP,
  SkyboxBackground,
  Skylight,
  TONEMAP_ACES_FILMIC,
} from '@forgeax/engine/render';
import { ChildOf, Name, Transform } from '@forgeax/engine/scene';
import type { AssetGuid, LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import {
  ASSET_IDS,
  guidText,
  PACKAGE_IDS,
  SUN_OUTGOING_DIRECTION,
} from '../src/asset-ids.ts';

const assets = {
  'scene/showcase': {
    guid: ASSET_IDS.showcaseScene,
    kind: 'scene',
    name: 'Game 3D / Lighting Showcase',
  },
} as const;

function meshEntity(
  localId: number,
  name: string,
  mesh: AssetGuid,
  position: readonly [number, number, number],
  scale: readonly [number, number, number] = [1, 1, 1],
  rotation: readonly [number, number, number, number] = [0, 0, 0, 1],
  extra: Record<string, Record<string, unknown>> = {},
): SceneEntity {
  return {
    localId: localId as LocalEntityId,
    components: {
      Name: { value: name },
      Transform: { pos: position, scale, quat: rotation },
      MeshFilter: { assetHandle: guidText(mesh) },
      MeshRenderer: { materials: [] },
      ...extra,
    },
  };
}

function showcaseScene(): SceneAsset {
  const cameraPosition = [0, 4.1, 15.2] as const;
  const target = [0, 1.15, 7.4] as const;
  const cameraRotation = quat.fromLookAt(quat.create(), cameraPosition, target, [0, 1, 0]);
  return {
    kind: 'scene',
    entities: [
      meshEntity(0, 'Ground', ASSET_IDS.groundMesh, [0, -0.2, 0], [1, 1, 1], [0, 0, 0, 1], {
        RigidBody: { type: RigidBodyTypeValue.static },
        Collider: {
          shape: ColliderShapeValue.cuboid,
          halfExtents: [24, 0.2, 24],
          friction: 0.9,
          restitution: 0,
        },
      }),
      meshEntity(1, 'Pedestal', ASSET_IDS.pedestalMesh, [-3, 0.5, -2]),
      meshEntity(2, 'Metal Sphere', ASSET_IDS.sphereMesh, [-3, 1.75, -2]),
      meshEntity(3, 'Painted Cube', ASSET_IDS.cubeMesh, [0, 0.75, -3]),
      meshEntity(
        4,
        'Metal Torus',
        ASSET_IDS.torusMesh,
        [3.2, 1.15, -2],
        [1, 1, 1],
        [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)],
      ),
      meshEntity(5, 'Point Light Marker', ASSET_IDS.lightMesh, [0, 4.2, 0]),
      {
        localId: 6 as LocalEntityId,
        components: {
          Name: { value: 'Sun' },
          DirectionalLight: {
            direction: SUN_OUTGOING_DIRECTION,
            color: [1, 0.98, 0.93],
            intensity: 3.2,
            castShadow: true,
            cascadeCount: 3,
            splitLambda: 0.72,
            cascadeBlend: 0.18,
            mapSize: 2048,
            depthBias: 0.005,
            normalBias: 0.06,
            shadowDistance: 72,
            pcfKernelSize: 3,
          },
        },
      },
      {
        localId: 7 as LocalEntityId,
        components: {
          Name: { value: 'Warm Point Light' },
          Transform: { pos: [0, 4.2, 0] },
          PointLight: { color: [1, 0.32, 0.08], intensity: 45, range: 11 },
        },
      },
      {
        localId: 8 as LocalEntityId,
        components: {
          Name: { value: 'Analytic Skylight' },
          Skylight: {
            equirect: guidText(ASSET_IDS.daylight),
            color: [1, 1, 1],
            intensity: 0.8,
          },
        },
      },
      {
        localId: 9 as LocalEntityId,
        components: {
          Name: { value: 'Analytic Sky Background' },
          SkyboxBackground: {
            equirect: guidText(ASSET_IDS.daylight),
            mode: SKYBOX_MODE_CUBEMAP,
          },
        },
      },
      {
        localId: 10 as LocalEntityId,
        components: {
          Name: { value: 'Main Camera' },
          Transform: {
            pos: cameraPosition,
            quat: [
              cameraRotation[0] ?? 0,
              cameraRotation[1] ?? 0,
              cameraRotation[2] ?? 0,
              cameraRotation[3] ?? 1,
            ],
          },
          Camera: {
            ...perspective({ fov: Math.PI / 4, aspect: 16 / 9, near: 0.1, far: 160 }),
            tonemap: TONEMAP_ACES_FILMIC,
            exposure: 0.9,
            antialias: ANTIALIAS_FXAA,
            clearColor: [0.18, 0.36, 0.68, 1],
          },
        },
      },
      meshEntity(11, 'Player', ASSET_IDS.playerMesh, [0, 0.93, 9], [1, 1, 1], [0, 0, 0, 1], {
        RigidBody: { type: RigidBodyTypeValue.kinematic },
        Collider: {
          shape: ColliderShapeValue.capsule,
          radius: 0.38,
          halfHeight: 0.55,
          friction: 0.7,
          restitution: 0,
        },
        CharacterController: {
          offset: 0.03,
          maxSlopeClimbDeg: 48,
          minSlopeSlideDeg: 55,
          autoStepMaxHeight: 0.32,
          autoStepMinWidth: 0.15,
          snapToGroundDist: 0.24,
        },
      }),
      meshEntity(12, 'Player Heading Marker', ASSET_IDS.playerMarkerMesh, [0, 0.34, -0.39], [1, 1, 1], [0, 0, 0, 1], {
        ChildOf: { parent: 11 },
      }),
      meshEntity(13, 'West Walkable Platform', ASSET_IDS.platformMesh, [-7.5, 0.125, 2.5], [1, 1, 1], [0, 0, 0, 1], {
        RigidBody: { type: RigidBodyTypeValue.static },
        Collider: { shape: ColliderShapeValue.cuboid, halfExtents: [2, 0.125, 1.5], friction: 0.85 },
      }),
      meshEntity(14, 'East Walkable Platform', ASSET_IDS.platformMesh, [7.5, 0.125, -5], [1, 1, 1], [0, 0, 0, 1], {
        RigidBody: { type: RigidBodyTypeValue.static },
        Collider: { shape: ColliderShapeValue.cuboid, halfExtents: [2, 0.125, 1.5], friction: 0.85 },
      }),
      meshEntity(15, 'North Walkable Platform', ASSET_IDS.platformMesh, [-4, 0.125, -11], [1, 1, 1], [0, 0, 0, 1], {
        RigidBody: { type: RigidBodyTypeValue.static },
        Collider: { shape: ColliderShapeValue.cuboid, halfExtents: [2, 0.125, 1.5], friction: 0.85 },
      }),
      meshEntity(16, 'South Walkable Platform', ASSET_IDS.platformMesh, [5, 0.125, 10.5], [1, 1, 1], [0, 0, 0, 1], {
        RigidBody: { type: RigidBodyTypeValue.static },
        Collider: { shape: ColliderShapeValue.cuboid, halfExtents: [2, 0.125, 1.5], friction: 0.85 },
      }),
      meshEntity(17, 'Northwest Pillar', ASSET_IDS.pillarMesh, [-11, 1.5, -10], [1, 1, 1], [0, 0, 0, 1], {
        RigidBody: { type: RigidBodyTypeValue.static },
        Collider: { shape: ColliderShapeValue.cuboid, halfExtents: [0.55, 1.5, 0.55], friction: 0.8 },
      }),
      meshEntity(18, 'Northeast Pillar', ASSET_IDS.pillarMesh, [11, 1.5, -10], [1, 1, 1], [0, 0, 0, 1], {
        RigidBody: { type: RigidBodyTypeValue.static },
        Collider: { shape: ColliderShapeValue.cuboid, halfExtents: [0.55, 1.5, 0.55], friction: 0.8 },
      }),
      meshEntity(19, 'Klein Bottle', ASSET_IDS.kleinBottleMesh, [-4.3, 2.25, 5.2], [0.72, 0.72, 0.72]),
      meshEntity(
        20,
        'Trefoil Knot',
        ASSET_IDS.trefoilKnotMesh,
        [4.3, 2.2, 4.5],
        [1.05, 1.05, 1.05],
        [Math.sin(-Math.PI / 12), 0, 0, Math.cos(-Math.PI / 12)],
      ),
      meshEntity(
        21,
        'Astral Bloom',
        ASSET_IDS.astralBloomMesh,
        [0, 2.15, -0.8],
        [1.15, 1.15, 1.15],
        [Math.sin(Math.PI / 8), 0, 0, Math.cos(Math.PI / 8)],
      ),
    ],
  };
}

export default {
  schemaVersion: '1.0.0',
  packageId: PACKAGE_IDS.scene,
  name: 'Game 3D / Scene',
  assets,
  sceneComponents: [
    Camera,
    CharacterController,
    ChildOf,
    Collider,
    DirectionalLight,
    MeshFilter,
    MeshRenderer,
    Name,
    PointLight,
    RigidBody,
    SkyboxBackground,
    Skylight,
    Transform,
  ],
  externalAssets: {
    daylight: ASSET_IDS.daylight,
    groundMesh: ASSET_IDS.groundMesh,
    cubeMesh: ASSET_IDS.cubeMesh,
    sphereMesh: ASSET_IDS.sphereMesh,
    pedestalMesh: ASSET_IDS.pedestalMesh,
    torusMesh: ASSET_IDS.torusMesh,
    lightMesh: ASSET_IDS.lightMesh,
    playerMesh: ASSET_IDS.playerMesh,
    playerMarkerMesh: ASSET_IDS.playerMarkerMesh,
    platformMesh: ASSET_IDS.platformMesh,
    pillarMesh: ASSET_IDS.pillarMesh,
    kleinBottleMesh: ASSET_IDS.kleinBottleMesh,
    trefoilKnotMesh: ASSET_IDS.trefoilKnotMesh,
    astralBloomMesh: ASSET_IDS.astralBloomMesh,
  },
  build: () => ok({ 'scene/showcase': showcaseScene() }),
} satisfies ScriptablePackDefinition<typeof assets>;

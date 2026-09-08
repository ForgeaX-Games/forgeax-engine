import {
  createBoxGeometry,
  createCapsuleGeometry,
  createCylinderGeometry,
  createSphereGeometry,
  createTorusGeometry,
} from '@forgeax/engine/geometry';
import type { ScriptablePackDefinition } from '@forgeax/engine/pack/source';
import type { AssetGuid, MeshAsset } from '@forgeax/engine/types';
import { ok } from '@forgeax/engine/types';
import { ASSET_IDS, PACKAGE_IDS } from '../src/asset-ids.ts';

const assets = {
  'mesh/ground': { guid: ASSET_IDS.groundMesh, kind: 'mesh', name: 'Game 3D / Ground Mesh' },
  'mesh/cube': { guid: ASSET_IDS.cubeMesh, kind: 'mesh', name: 'Game 3D / Cube Mesh' },
  'mesh/sphere': { guid: ASSET_IDS.sphereMesh, kind: 'mesh', name: 'Game 3D / Sphere Mesh' },
  'mesh/pedestal': {
    guid: ASSET_IDS.pedestalMesh,
    kind: 'mesh',
    name: 'Game 3D / Pedestal Mesh',
  },
  'mesh/torus': { guid: ASSET_IDS.torusMesh, kind: 'mesh', name: 'Game 3D / Torus Mesh' },
  'mesh/light': { guid: ASSET_IDS.lightMesh, kind: 'mesh', name: 'Game 3D / Light Marker' },
  'mesh/player': { guid: ASSET_IDS.playerMesh, kind: 'mesh', name: 'Game 3D / Player' },
  'mesh/player-marker': {
    guid: ASSET_IDS.playerMarkerMesh,
    kind: 'mesh',
    name: 'Game 3D / Player Heading Marker',
  },
  'mesh/platform': {
    guid: ASSET_IDS.platformMesh,
    kind: 'mesh',
    name: 'Game 3D / Walkable Platform',
  },
  'mesh/pillar': { guid: ASSET_IDS.pillarMesh, kind: 'mesh', name: 'Game 3D / Pillar' },
} as const;

function withMaterial(mesh: MeshAsset, material: AssetGuid, sourceKey: string): MeshAsset {
  return {
    ...mesh,
    materialSlots: [{ slotName: 'surface', sourceKey, defaultMaterial: material }],
  };
}

export default {
  schemaVersion: '1.0.0',
  packageId: PACKAGE_IDS.geometry,
  name: 'Game 3D / Geometry',
  assets,
  externalAssets: {
    groundMaterial: ASSET_IDS.groundMaterial,
    paintedMaterial: ASSET_IDS.paintedMaterial,
    metalMaterial: ASSET_IDS.metalMaterial,
    whiteMaterial: ASSET_IDS.whiteMaterial,
    lightMaterial: ASSET_IDS.lightMaterial,
    playerMaterial: ASSET_IDS.playerMaterial,
    playerAccentMaterial: ASSET_IDS.playerAccentMaterial,
  },
  build: () => {
    const ground = createBoxGeometry(48, 0.4, 48);
    if (!ground.ok) return ground;
    const cube = createBoxGeometry(1.5, 1.5, 1.5);
    if (!cube.ok) return cube;
    const sphere = createSphereGeometry(0.9, 48, 32);
    if (!sphere.ok) return sphere;
    const pedestal = createCylinderGeometry(0.75, 0.9, 1, 32, 1);
    if (!pedestal.ok) return pedestal;
    const torus = createTorusGeometry(1, 0.24, 20, 64);
    if (!torus.ok) return torus;
    const light = createSphereGeometry(0.13, 16, 10);
    if (!light.ok) return light;
    const player = createCapsuleGeometry(0.38, 1.1, 6, 24);
    if (!player.ok) return player;
    const playerMarker = createBoxGeometry(0.28, 0.14, 0.1);
    if (!playerMarker.ok) return playerMarker;
    const platform = createBoxGeometry(4, 0.25, 3);
    if (!platform.ok) return platform;
    const pillar = createBoxGeometry(1.1, 3, 1.1);
    if (!pillar.ok) return pillar;
    return ok({
      'mesh/ground': withMaterial(ground.value, ASSET_IDS.groundMaterial, 'game-3d:ground'),
      'mesh/cube': withMaterial(cube.value, ASSET_IDS.paintedMaterial, 'game-3d:cube'),
      'mesh/sphere': withMaterial(sphere.value, ASSET_IDS.metalMaterial, 'game-3d:sphere'),
      'mesh/pedestal': withMaterial(
        pedestal.value,
        ASSET_IDS.whiteMaterial,
        'game-3d:pedestal',
      ),
      'mesh/torus': withMaterial(torus.value, ASSET_IDS.metalMaterial, 'game-3d:torus'),
      'mesh/light': withMaterial(light.value, ASSET_IDS.lightMaterial, 'game-3d:light'),
      'mesh/player': withMaterial(
        player.value,
        ASSET_IDS.playerMaterial,
        'game-3d:player',
      ),
      'mesh/player-marker': withMaterial(
        playerMarker.value,
        ASSET_IDS.playerAccentMaterial,
        'game-3d:player-marker',
      ),
      'mesh/platform': withMaterial(
        platform.value,
        ASSET_IDS.whiteMaterial,
        'game-3d:platform',
      ),
      'mesh/pillar': withMaterial(
        pillar.value,
        ASSET_IDS.whiteMaterial,
        'game-3d:pillar',
      ),
    });
  },
} satisfies ScriptablePackDefinition<typeof assets>;

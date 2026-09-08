import type { ScriptablePackDefinition } from '@forgeax/engine/pack/source';
import { Materials } from '@forgeax/engine/render';
import { ok } from '@forgeax/engine/types';
import { ASSET_IDS, PACKAGE_IDS } from '../src/asset-ids.ts';

const assets = {
  'material/ground': {
    guid: ASSET_IDS.groundMaterial,
    kind: 'material',
    name: 'Game 3D / Ground',
  },
  'material/painted': {
    guid: ASSET_IDS.paintedMaterial,
    kind: 'material',
    name: 'Game 3D / Painted',
  },
  'material/metal': {
    guid: ASSET_IDS.metalMaterial,
    kind: 'material',
    name: 'Game 3D / Brushed Metal',
  },
  'material/white': {
    guid: ASSET_IDS.whiteMaterial,
    kind: 'material',
    name: 'Game 3D / Matte White',
  },
  'material/light': {
    guid: ASSET_IDS.lightMaterial,
    kind: 'material',
    name: 'Game 3D / Warm Light',
  },
  'material/player': {
    guid: ASSET_IDS.playerMaterial,
    kind: 'material',
    name: 'Game 3D / Player',
  },
  'material/player-accent': {
    guid: ASSET_IDS.playerAccentMaterial,
    kind: 'material',
    name: 'Game 3D / Player Accent',
  },
  'material/fantasy-azure': {
    guid: ASSET_IDS.fantasyAzureMaterial,
    kind: 'material',
    name: 'Game 3D / Fantasy Azure',
  },
  'material/fantasy-violet': {
    guid: ASSET_IDS.fantasyVioletMaterial,
    kind: 'material',
    name: 'Game 3D / Fantasy Violet',
  },
  'material/fantasy-gold': {
    guid: ASSET_IDS.fantasyGoldMaterial,
    kind: 'material',
    name: 'Game 3D / Fantasy Gold',
  },
} as const;

export default {
  schemaVersion: '1.0.0',
  packageId: PACKAGE_IDS.materials,
  name: 'Game 3D / Materials',
  assets,
  externalAssets: {},
  build: () =>
    ok({
      'material/ground': Materials.standard({
        baseColor: [0.32, 0.34, 0.37, 1],
        metallic: 0,
        roughness: 0.9,
      }),
      'material/painted': Materials.standard({
        baseColor: [0.06, 0.28, 0.72, 1],
        metallic: 0.05,
        roughness: 0.32,
      }),
      'material/metal': Materials.standard({
        baseColor: [0.72, 0.75, 0.8, 1],
        metallic: 0.92,
        roughness: 0.16,
      }),
      'material/white': Materials.standard({
        baseColor: [0.82, 0.78, 0.7, 1],
        metallic: 0,
        roughness: 0.58,
      }),
      'material/light': Materials.standard({
        baseColor: [1, 0.45, 0.12, 1],
        emissive: [1, 0.12, 0.015],
        emissiveIntensity: 5,
        metallic: 0,
        roughness: 0.24,
        castShadow: false,
      }),
      'material/player': Materials.standard({
        baseColor: [0.025, 0.42, 0.56, 1],
        metallic: 0.05,
        roughness: 0.36,
      }),
      'material/player-accent': Materials.standard({
        baseColor: [1, 0.34, 0.04, 1],
        emissive: [0.65, 0.08, 0.005],
        emissiveIntensity: 1.2,
        metallic: 0,
        roughness: 0.28,
      }),
      'material/fantasy-azure': Materials.standard({
        baseColor: [0.025, 0.48, 0.82, 1],
        emissive: [0.01, 0.18, 0.42],
        emissiveIntensity: 1.4,
        metallic: 0.42,
        roughness: 0.2,
        clearcoat: 0.65,
        clearcoatRoughness: 0.12,
      }),
      'material/fantasy-violet': Materials.standard({
        baseColor: [0.34, 0.045, 0.72, 1],
        emissive: [0.16, 0.01, 0.38],
        emissiveIntensity: 1.7,
        metallic: 0.26,
        roughness: 0.24,
        clearcoat: 0.5,
        clearcoatRoughness: 0.16,
      }),
      'material/fantasy-gold': Materials.standard({
        baseColor: [0.95, 0.48, 0.055, 1],
        emissive: [0.72, 0.16, 0.012],
        emissiveIntensity: 2.2,
        metallic: 0.78,
        roughness: 0.18,
        clearcoat: 0.3,
      }),
    }),
} satisfies ScriptablePackDefinition<typeof assets>;

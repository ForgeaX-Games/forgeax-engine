import { AssetGuid } from '@forgeax/engine/pack/guid';
import type { AssetGuid as AssetGuidType } from '@forgeax/engine/types';

function guid(value: string): AssetGuidType {
  const parsed = AssetGuid.parse(value);
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

export function guidText(value: AssetGuidType): string {
  return AssetGuid.format(value);
}

export const PACKAGE_IDS = Object.freeze({
  environment: guid('019fb7ce-3100-7000-8000-000000000000'),
  materials: guid('019fb7ce-3200-7000-8000-000000000000'),
  geometry: guid('019fb7ce-3300-7000-8000-000000000000'),
  scene: guid('019fb7ce-3400-7000-8000-000000000000'),
  fantasyMeshes: guid('019fb7ce-3500-7000-8000-000000000000'),
});

export const ASSET_IDS = Object.freeze({
  daylight: guid('019fb7ce-3100-7000-8000-000000000001'),
  groundMaterial: guid('019fb7ce-3200-7000-8000-000000000001'),
  paintedMaterial: guid('019fb7ce-3200-7000-8000-000000000002'),
  metalMaterial: guid('019fb7ce-3200-7000-8000-000000000003'),
  whiteMaterial: guid('019fb7ce-3200-7000-8000-000000000004'),
  lightMaterial: guid('019fb7ce-3200-7000-8000-000000000005'),
  playerMaterial: guid('019fb7ce-3200-7000-8000-000000000006'),
  playerAccentMaterial: guid('019fb7ce-3200-7000-8000-000000000007'),
  fantasyAzureMaterial: guid('019fb7ce-3200-7000-8000-000000000008'),
  fantasyVioletMaterial: guid('019fb7ce-3200-7000-8000-000000000009'),
  fantasyGoldMaterial: guid('019fb7ce-3200-7000-8000-00000000000a'),
  groundMesh: guid('019fb7ce-3300-7000-8000-000000000001'),
  cubeMesh: guid('019fb7ce-3300-7000-8000-000000000002'),
  sphereMesh: guid('019fb7ce-3300-7000-8000-000000000003'),
  pedestalMesh: guid('019fb7ce-3300-7000-8000-000000000004'),
  torusMesh: guid('019fb7ce-3300-7000-8000-000000000005'),
  lightMesh: guid('019fb7ce-3300-7000-8000-000000000006'),
  playerMesh: guid('019fb7ce-3300-7000-8000-000000000007'),
  playerMarkerMesh: guid('019fb7ce-3300-7000-8000-000000000008'),
  platformMesh: guid('019fb7ce-3300-7000-8000-000000000009'),
  pillarMesh: guid('019fb7ce-3300-7000-8000-00000000000a'),
  showcaseScene: guid('019fb7ce-3400-7000-8000-000000000001'),
  kleinBottleMesh: guid('019fb7ce-3500-7000-8000-000000000001'),
  trefoilKnotMesh: guid('019fb7ce-3500-7000-8000-000000000002'),
  astralBloomMesh: guid('019fb7ce-3500-7000-8000-000000000003'),
});

/** Direction stored by DirectionalLight: outgoing from the Sun toward the scene. */
export const SUN_OUTGOING_DIRECTION = [-0.32, -0.91, -0.24] as const;

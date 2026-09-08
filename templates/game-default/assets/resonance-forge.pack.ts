import {
  createCapsuleGeometry,
  createConeGeometry,
  createSphereGeometry,
  createTorusGeometry,
} from '@forgeax/engine-geometry';
import { quat } from '@forgeax/engine-math';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { MeshFilter, MeshRenderer } from '@forgeax/engine-render';
import { Name, Transform } from '@forgeax/engine-scene';
import type {
  AssetReader,
  ScriptablePackAssetDeclarations,
  ScriptablePackDefinition,
  ScriptablePackOutputs,
} from '@forgeax/engine-pack/source';
import type {
  AnimationClip,
  AnimationGraph,
  AudioClipAsset,
  LocalEntityId,
  ParticleEffectAsset,
  SamplerAsset,
  SceneAsset,
  TextureAsset,
} from '@forgeax/engine-types';
import { AssetError, err, ok } from '@forgeax/engine-types';
import {
  bindMaterialSlots,
  createResonanceFormation,
  guid,
  resonanceMaterial,
  resonancePose,
  type ResonanceRole,
} from './procedural/resonance-blueprint.ts';

const PACKAGE_NAME = 'Resonance Forge' as const;

const assets = {
  'material/void-alloy': {
    guid: guid('019fb264-1000-7000-8000-000000000001'),
    kind: 'material',
    name: `${PACKAGE_NAME} / Void Alloy`,
  },
  'material/ion-cyan': {
    guid: guid('019fb264-1000-7000-8000-000000000002'),
    kind: 'material',
    name: `${PACKAGE_NAME} / Ion Cyan`,
  },
  'material/plasma-violet': {
    guid: guid('019fb264-1000-7000-8000-000000000003'),
    kind: 'material',
    name: `${PACKAGE_NAME} / Plasma Violet`,
  },
  'material/solar-gold': {
    guid: guid('019fb264-1000-7000-8000-000000000004'),
    kind: 'material',
    name: `${PACKAGE_NAME} / Solar Gold`,
  },
  'geometry/outer-ring': {
    guid: guid('019fb264-1000-7000-8000-000000000011'),
    kind: 'mesh',
    name: `${PACKAGE_NAME} / Outer Ring`,
  },
  'geometry/inner-ring': {
    guid: guid('019fb264-1000-7000-8000-000000000012'),
    kind: 'mesh',
    name: `${PACKAGE_NAME} / Inner Ring`,
  },
  'geometry/pylon': {
    guid: guid('019fb264-1000-7000-8000-000000000013'),
    kind: 'mesh',
    name: `${PACKAGE_NAME} / Pylon`,
  },
  'geometry/orb': {
    guid: guid('019fb264-1000-7000-8000-000000000014'),
    kind: 'mesh',
    name: `${PACKAGE_NAME} / Orb`,
  },
  'geometry/anchor': {
    guid: guid('019fb264-1000-7000-8000-000000000015'),
    kind: 'mesh',
    name: `${PACKAGE_NAME} / Anchor`,
  },
  'scene/formation': {
    guid: guid('019fb264-1000-7000-8000-000000000021'),
    kind: 'scene',
    name: `${PACKAGE_NAME} / Formation`,
  },
  'texture/resonance-atlas': {
    guid: guid('019fb264-1000-7000-8000-000000000031'),
    kind: 'texture',
    name: `${PACKAGE_NAME} / Resonance Atlas`,
  },
  'sampler/resonance': {
    guid: guid('019fb264-1000-7000-8000-000000000032'),
    kind: 'sampler',
    name: `${PACKAGE_NAME} / Resonance Sampler`,
  },
  'animation/clip': {
    guid: guid('019fb264-1000-7000-8000-000000000033'),
    kind: 'animation-clip',
    name: `${PACKAGE_NAME} / Resonance Pulse Clip`,
  },
  'animation/graph': {
    guid: guid('019fb264-1000-7000-8000-000000000034'),
    kind: 'animation-graph',
    name: `${PACKAGE_NAME} / Resonance Pulse Graph`,
  },
  'audio/diagnostic': {
    guid: guid('019fb264-1000-7000-8000-000000000035'),
    kind: 'audio',
    name: `${PACKAGE_NAME} / Diagnostic Tone`,
  },
  'vfx/charge': {
    guid: guid('019fb264-1000-7000-8000-000000000036'),
    kind: 'particle-effect',
    name: `${PACKAGE_NAME} / Charge VFX`,
  },
} as const satisfies ScriptablePackAssetDeclarations;

const CHARGE_VFX_SOURCE_GUID = guid('019e9c00-0000-7000-8000-000000000020');

function guidText(value: (typeof assets)[keyof typeof assets]['guid']): string {
  return AssetGuid.format(value);
}

function visualFor(role: ResonanceRole): {
  readonly mesh: string;
  readonly materials: readonly string[];
} {
  switch (role) {
    case 'outer-ring':
      return {
        mesh: guidText(assets['geometry/outer-ring'].guid),
        materials: [
          guidText(assets['material/void-alloy'].guid),
          guidText(assets['material/ion-cyan'].guid),
        ],
      };
    case 'inner-ring':
      return {
        mesh: guidText(assets['geometry/inner-ring'].guid),
        materials: [
          guidText(assets['material/plasma-violet'].guid),
          guidText(assets['material/solar-gold'].guid),
        ],
      };
    case 'pylon':
      return {
        mesh: guidText(assets['geometry/pylon'].guid),
        materials: [guidText(assets['material/void-alloy'].guid)],
      };
    case 'orb':
      return {
        mesh: guidText(assets['geometry/orb'].guid),
        materials: [guidText(assets['material/plasma-violet'].guid)],
      };
    case 'anchor':
      return {
        mesh: guidText(assets['geometry/anchor'].guid),
        materials: [guidText(assets['material/solar-gold'].guid)],
      };
  }
}

function createResonanceScene(): SceneAsset {
  const rotation = quat.create();
  return {
    kind: 'scene',
    entities: createResonanceFormation().map((node, localId) => {
      const pose = resonancePose(node, 0, rotation);
      const visual = visualFor(node.role);
      return {
        localId: localId as LocalEntityId,
        components: {
          Name: { value: `Resonance ${node.role} ${node.index + 1}/${node.count}` },
          Transform: {
            pos: [...pose.position],
            quat: [rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0, rotation[3] ?? 1],
            scale: [...pose.scale],
          },
          MeshFilter: { assetHandle: visual.mesh },
          MeshRenderer: { materials: visual.materials },
        },
      };
    }),
  };
}

const scriptablePack = {
  schemaVersion: '1.0.0',
  packageId: guid('019fb264-1000-7000-8000-000000000000'),
  name: PACKAGE_NAME,
  assets,
  sceneComponents: [Name, Transform, MeshFilter, MeshRenderer],
  externalAssets: { chargeVfx: CHARGE_VFX_SOURCE_GUID },
  async build(assetReader: AssetReader) {
    const outer = createTorusGeometry(3.4, 0.16, 16, 96);
    if (!outer.ok) return outer;
    const inner = createTorusGeometry(1.85, 0.1, 12, 72);
    if (!inner.ok) return inner;
    const pylon = createConeGeometry(0.34, 2.4, 24, 3);
    if (!pylon.ok) return pylon;
    const orb = createSphereGeometry(0.28, 24, 16);
    if (!orb.ok) return orb;
    const anchor = createCapsuleGeometry(0.18, 1.25, 8, 20);
    if (!anchor.ok) return anchor;

    const chargeVfx = await assetReader.readByGuid<ParticleEffectAsset>(CHARGE_VFX_SOURCE_GUID);
    if (!chargeVfx.ok) {
      return err(
        new AssetError({
          code: 'asset-fetch-failed',
          expected: 'the declared charge particle-effect source asset',
          hint: 'ensure charge-vfx-effect.pack.json is included in the Pack roots',
          detail: { sourcePath: 'charge-vfx-effect.pack.json' },
        }),
      );
    }

    return ok({
      'material/void-alloy': resonanceMaterial([0.025, 0.035, 0.075, 1], [0.01, 0.02, 0.06], 1.2, 0.92, 0.16),
      'material/ion-cyan': resonanceMaterial([0.02, 0.42, 0.62, 1], [0.01, 0.65, 1], 7.5, 0.2, 0.22),
      'material/plasma-violet': resonanceMaterial([0.36, 0.04, 0.62, 1], [0.68, 0.03, 1], 8.5, 0.12, 0.18),
      'material/solar-gold': resonanceMaterial([0.88, 0.38, 0.035, 1], [1, 0.22, 0.015], 6.2, 0.65, 0.2),
      'geometry/outer-ring': bindMaterialSlots(outer.value, [
        { name: 'Void Frame', sourceKey: 'void-frame', material: assets['material/void-alloy'].guid },
        { name: 'Ion Conduit', sourceKey: 'ion-conduit', material: assets['material/ion-cyan'].guid },
      ]),
      'geometry/inner-ring': bindMaterialSlots(inner.value, [
        { name: 'Plasma Coil', sourceKey: 'plasma-coil', material: assets['material/plasma-violet'].guid },
        { name: 'Solar Contacts', sourceKey: 'solar-contacts', material: assets['material/solar-gold'].guid },
      ]),
      'geometry/pylon': bindMaterialSlots(pylon.value, [
        { name: 'Pylon Shell', sourceKey: 'pylon-shell', material: assets['material/void-alloy'].guid },
      ]),
      'geometry/orb': bindMaterialSlots(orb.value, [
        { name: 'Orb Plasma', sourceKey: 'orb-plasma', material: assets['material/plasma-violet'].guid },
      ]),
      'geometry/anchor': bindMaterialSlots(anchor.value, [
        { name: 'Anchor Energy', sourceKey: 'anchor-energy', material: assets['material/solar-gold'].guid },
      ]),
      'scene/formation': createResonanceScene(),
      'texture/resonance-atlas': {
        kind: 'texture',
        width: 1,
        height: 1,
        format: 'rgba8unorm-srgb',
        data: new Uint8Array([255, 255, 255, 255]),
        colorSpace: 'srgb',
        mipmap: false,
      } satisfies TextureAsset,
      'sampler/resonance': {
        kind: 'sampler',
        magFilter: 'linear',
        minFilter: 'linear',
        mipmapFilter: 'nearest',
      } satisfies SamplerAsset,
      'animation/clip': {
        kind: 'animation-clip',
        duration: 1,
        channels: [],
      } satisfies AnimationClip,
      'animation/graph': {
        kind: 'animation-graph',
        nodes: [{ type: 'clip', clip: guidText(assets['animation/clip'].guid), weight: 1 }],
        root: 0,
      } satisfies AnimationGraph,
      'audio/diagnostic': {
        kind: 'audio',
        sourceKey: 'resonance-forge/diagnostic-tone',
        mediaType: 'audio/wav',
        bytes: new Uint8Array([82, 73, 70, 70]),
      } satisfies AudioClipAsset,
      'vfx/charge': chargeVfx.value,
    } satisfies ScriptablePackOutputs<typeof assets>);
  },
} satisfies ScriptablePackDefinition<typeof assets, { readonly chargeVfx: typeof CHARGE_VFX_SOURCE_GUID }, AssetError>;

export default scriptablePack;

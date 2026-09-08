import { quat } from '@forgeax/engine-math';
import type { AssetReader } from '@forgeax/engine-pack/source';
import type {
  Asset,
  MaterialAsset,
  MeshAsset,
  ParticleEffectAsset,
  SceneAsset,
} from '@forgeax/engine-types';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import scriptablePack from '../assets/resonance-forge.pack';
import { createResonanceFormation, resonancePose } from '../assets/procedural/resonance-blueprint';

describe('Resonance Forge ScriptablePack dogfood', () => {
  it('builds all ordinary output kinds and keeps the external VFX payload cooked', async () => {
    const particle: ParticleEffectAsset = {
      kind: 'particle-effect',
      schemaVersion: 2,
      programFingerprint: 'resonance-test',
      emitters: [{ id: 'charge', capacity: 8 }],
      program: {
        format: 'forgeax-vfx-program-2',
        fingerprint: 'resonance-test',
        emitters: [],
      },
    };
    const reader: AssetReader = {
      async readByGuid<TAsset extends Asset>() {
        return ok(particle as TAsset);
      },
    };
    const built = await scriptablePack.build(reader);
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(Object.keys(built.value)).toHaveLength(16);
    const materials = Object.values(built.value).filter(
      (asset): asset is MaterialAsset => asset.kind === 'material',
    );
    const meshes = Object.values(built.value).filter(
      (asset): asset is MeshAsset => asset.kind === 'mesh',
    );
    const scenes = Object.values(built.value).filter(
      (asset): asset is SceneAsset => asset.kind === 'scene',
    );
    expect(materials).toHaveLength(4);
    expect(materials.every((material) => material.passes?.length === 2)).toBe(true);
    expect(meshes).toHaveLength(5);
    expect(scenes).toHaveLength(1);
    expect(meshes.reduce((vertices, mesh) => vertices + mesh.vertices.length / 12, 0)).toBeGreaterThan(3_000);
    expect(meshes.every((mesh) => mesh.materialSlots.length > 0 && mesh.aabb?.length === 6)).toBe(true);
    expect(built.value['geometry/outer-ring'].materialSlots).toHaveLength(2);
    expect(built.value['geometry/inner-ring'].submeshes).toHaveLength(2);
    expect(built.value['scene/formation'].entities).toHaveLength(28);
    expect(built.value['scene/formation'].entities.map((entity) => entity.localId)).toEqual(
      Array.from({ length: 28 }, (_, localId) => localId),
    );
    expect(
      built.value['scene/formation'].entities.every(
        (entity) =>
          typeof entity.components.MeshFilter?.assetHandle === 'string' &&
          Array.isArray(entity.components.MeshRenderer?.materials),
      ),
    ).toBe(true);
    expect(built.value['texture/resonance-atlas'].kind).toBe('texture');
    expect(built.value['sampler/resonance'].kind).toBe('sampler');
    expect(built.value['animation/clip'].kind).toBe('animation-clip');
    expect(built.value['animation/graph'].nodes[0]?.type).toBe('clip');
    expect(built.value['audio/diagnostic'].kind).toBe('audio');
    expect(built.value['vfx/charge']).toBe(particle);
  });

  it('drives 28 deterministic nodes across all generated mesh roles', () => {
    const formation = createResonanceFormation();
    expect(formation).toHaveLength(28);
    expect(new Set(formation.map((node) => node.role))).toEqual(
      new Set(['outer-ring', 'inner-ring', 'pylon', 'orb', 'anchor']),
    );

    const rotation = quat.create();
    const initial = formation.map((node) => resonancePose(node, 0, rotation).position);
    const advanced = formation.map((node) => resonancePose(node, 2.5, rotation).position);
    expect(advanced).not.toEqual(initial);
    expect(advanced.every((position) => position.every(Number.isFinite))).toBe(true);
  });
});

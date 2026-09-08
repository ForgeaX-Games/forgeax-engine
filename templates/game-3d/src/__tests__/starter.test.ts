import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import environmentPack from '../../assets/environment.pack.ts';
import fantasyMeshesPack from '../../assets/fantasy-meshes.pack.ts';
import geometryPack from '../../assets/geometry.pack.ts';
import materialsPack from '../../assets/materials.pack.ts';
import scenePack from '../../assets/scene.pack.ts';

async function build(pack: { readonly build: (reader: never) => unknown }): Promise<Record<string, unknown>> {
  const result = await pack.build(undefined as never);
  if (typeof result !== 'object' || result === null || !('ok' in result) || result.ok !== true) {
    throw new Error(`ScriptablePack build failed: ${JSON.stringify(result)}`);
  }
  return (result as unknown as { readonly value: Record<string, unknown> }).value;
}

describe('game-3d starter', () => {
  it('keeps the asset root pack.ts-only', async () => {
    const entries = (await readdir(new URL('../../assets/', import.meta.url))).sort();
    expect(entries).toEqual([
      'environment.pack.ts',
      'fantasy-meshes.pack.ts',
      'geometry.pack.ts',
      'materials.pack.ts',
      'scene.pack.ts',
    ]);
  });

  it('builds a generated HDR analytic daylight', async () => {
    const outputs = await build(environmentPack);
    const daylight = outputs['environment/daylight'] as {
      readonly kind: string;
      readonly width: number;
      readonly height: number;
      readonly format: string;
      readonly data: Uint8Array;
    };
    expect(daylight).toMatchObject({
      kind: 'equirect',
      width: 256,
      height: 128,
      format: 'rgba16float',
    });
    expect(daylight.data.byteLength).toBe(256 * 128 * 8);
    expect(daylight.data.some((value) => value !== 0)).toBe(true);
  });

  it('builds separate material and geometry packs', async () => {
    expect(Object.keys(await build(materialsPack))).toHaveLength(10);
    expect(Object.keys(await build(geometryPack))).toHaveLength(10);
  });

  it('builds three fantasy meshes with three explicit material submeshes each', async () => {
    const outputs = await build(fantasyMeshesPack);
    expect(Object.keys(outputs)).toEqual([
      'mesh/klein-bottle',
      'mesh/trefoil-knot',
      'mesh/astral-bloom',
    ]);
    const kleinBottle = outputs['mesh/klein-bottle'] as {
      readonly vertices: Float32Array;
      readonly indices: Uint16Array | Uint32Array;
    };
    expect(kleinBottle.vertices).toHaveLength((72 + 1) * (28 + 1) * 2 * 12);
    expect(kleinBottle.indices).toHaveLength(72 * 28 * 2 * 6);
    for (const output of Object.values(outputs)) {
      const mesh = output as {
        readonly vertices: Float32Array;
        readonly indices?: Uint16Array | Uint32Array;
        readonly aabb?: Float32Array;
        readonly submeshes: readonly {
          readonly indexOffset: number;
          readonly indexCount: number;
          readonly materialSlot: number;
        }[];
        readonly materialSlots: readonly {
          readonly slotName: string;
          readonly sourceKey?: string;
          readonly defaultMaterial?: Uint8Array;
        }[];
      };
      expect(mesh.vertices.length).toBeGreaterThan(0);
      expect(Array.from(mesh.vertices).every(Number.isFinite)).toBe(true);
      expect(mesh.indices?.length).toBeGreaterThan(0);
      expect(mesh.aabb).toHaveLength(6);
      expect(Array.from(mesh.aabb ?? []).every(Number.isFinite)).toBe(true);
      expect(mesh.submeshes.map((submesh) => submesh.materialSlot)).toEqual([0, 1, 2]);
      expect(mesh.materialSlots.map((slot) => slot.slotName)).toEqual([
        'Azure Flux',
        'Violet Rift',
        'Solar Gold',
      ]);
      expect(new Set(mesh.materialSlots.map((slot) => slot.sourceKey)).size).toBe(3);
      expect(mesh.materialSlots.every((slot) => slot.defaultMaterial?.byteLength === 16)).toBe(true);
      expect(
        mesh.submeshes.every(
          (submesh, index) =>
            submesh.indexCount > 0 &&
            submesh.indexOffset ===
              mesh.submeshes
                .slice(0, index)
                .reduce((total, previous) => total + previous.indexCount, 0),
        ),
      ).toBe(true);
    }
  });

  it('authors the normal 3D light and shadow path in the default scene', async () => {
    const outputs = await build(scenePack);
    const scene = outputs['scene/showcase'] as {
      readonly entities: readonly { readonly components: Record<string, Record<string, unknown>> }[];
    };
    const components = scene.entities.map((entity) => entity.components);
    expect(components.find((entry) => entry.DirectionalLight)?.DirectionalLight).toMatchObject({
      castShadow: true,
      cascadeCount: 3,
    });
    expect(components.some((entry) => entry.PointLight !== undefined)).toBe(true);
    expect(components.some((entry) => entry.Skylight !== undefined)).toBe(true);
    expect(components.some((entry) => entry.SkyboxBackground !== undefined)).toBe(true);
    expect(components.some((entry) => entry.Camera !== undefined)).toBe(true);
    const player = components.find((entry) => entry.Name?.value === 'Player');
    expect(player).toMatchObject({
      RigidBody: { type: 2 },
      Collider: { radius: 0.38, halfHeight: 0.55 },
      CharacterController: { autoStepMaxHeight: 0.32, snapToGroundDist: 0.24 },
    });
    const ground = components.find((entry) => entry.Name?.value === 'Ground');
    expect(ground?.Collider?.halfExtents).toEqual([24, 0.2, 24]);
    expect(components.some((entry) => entry.Name?.value === 'Klein Bottle')).toBe(true);
    expect(components.some((entry) => entry.Name?.value === 'Trefoil Knot')).toBe(true);
    expect(components.some((entry) => entry.Name?.value === 'Astral Bloom')).toBe(true);
  });
});

import type { MaterialAsset, MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  canonicalMeshVertices,
  particleMaterialPass,
  particleMaterialUsesBindings,
} from '../feature/particle-resources.js';

describe('particle mesh resources', () => {
  it('preserves authored canonical vertices when the attribute map is empty', () => {
    const vertices = new Float32Array([
      0, 1, 0, 0, 1, 0, 0.5, 1, 1, 0, 0, 1, 0, -1, 0, 0, -1, 0, 0.5, 0, 1, 0, 0, 1,
    ]);
    const mesh = {
      vertices,
      indices: new Uint16Array([0, 1, 0]),
      attributes: {},
      submeshes: [],
    } as unknown as MeshAsset;

    expect(canonicalMeshVertices(mesh)).toBe(vertices);
  });
});

describe('particle material pass', () => {
  it('only requests the shared material bind group for a declared parameter contract', () => {
    expect(particleMaterialUsesBindings(undefined)).toBe(false);
    expect(particleMaterialUsesBindings({ kind: 'material', values: {} })).toBe(false);
    expect(
      particleMaterialUsesBindings({
        kind: 'material',
        parameters: [{ name: 'maskTexture', type: 'texture' }],
        values: {},
      }),
    ).toBe(true);
  });
  it('uses the renderer-specific authored shader and render state', () => {
    const material: MaterialAsset = {
      kind: 'material',
      passes: [
        { name: 'Forward', program: { module: 'game::standard' } },
        {
          name: 'particle-billboard',
          program: { module: 'game::hex-sigil' },
          renderState: { depthWriteEnabled: false, cullMode: 'none' },
        },
      ],
    };

    expect(particleMaterialPass('billboard', material)).toEqual({
      shader: 'game::hex-sigil',
      renderState: { depthWriteEnabled: false, cullMode: 'none' },
    });
  });

  it('does not mistake an ordinary Forward pass for a particle shader', () => {
    const material: MaterialAsset = {
      kind: 'material',
      passes: [{ name: 'Forward', program: { module: 'game::standard' } }],
    };

    expect(particleMaterialPass('mesh', material)).toEqual({
      shader: 'forgeax::vfx-render.particles.mesh',
    });
  });
});

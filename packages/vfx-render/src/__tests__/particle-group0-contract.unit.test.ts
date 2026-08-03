import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  resolveMaterialShaderBindingContract,
  resolveMaterialShaderVertexInputContract,
} from '@forgeax/engine-render/internal';
import { describe, expect, it } from 'vitest';
import { PARTICLE_SHADER_IDENTIFIERS } from '../index.js';

describe('particle shader group-0 contract', () => {
  it('resolves both public particle shader identifiers to the empty group-0 contract', () => {
    const shaderRoot = resolve(dirname(import.meta.dirname), 'shaders');
    for (const [kind, identifier] of Object.entries(PARTICLE_SHADER_IDENTIFIERS)) {
      const source = readFileSync(resolve(shaderRoot, `${kind}.wgsl`), 'utf8');
      expect(identifier).toMatch(/^forgeax::vfx-render\.particles\.(billboard|mesh)$/);
      expect(resolveMaterialShaderBindingContract(source)).toBe('group-0');
      expect(resolveMaterialShaderVertexInputContract(source)).toBe('render-material');
    }
  });
});

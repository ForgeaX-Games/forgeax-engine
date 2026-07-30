import { describe, expect, it } from 'vitest';
import { composeMaterial } from '../material/compose.js';
import { reflectMaterial } from '../reflection.js';
import {
  materialReflectionFixture,
  materialReflectionMismatchFixture,
} from './fixtures/material-reflection.fixtures.js';

describe('material composition and reflection', () => {
  it('composes a module closure and preserves pass and vertex reflection', async () => {
    const result = await composeMaterial(
      {
        material: materialReflectionFixture.material,
        pass: materialReflectionFixture.pass,
        source: materialReflectionFixture.source,
        imports: { 'game::common': '#define_import_path game::common\n' },
        defines: { USE_LIGHTING: true },
      },
      async () => ({
        wgsl: materialReflectionFixture.source,
        bindings: materialReflectionFixture.reflection.bindings,
        deps: ['game::common'],
        vertexInputs: materialReflectionFixture.reflection.vertexInputs,
      }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.material).toBe('painted-metal');
      expect(result.value.pass).toBe('Forward');
      expect(result.value.deps).toEqual(['game::common']);
      expect(result.value.vertexInputs).toEqual([{ location: 0, type: 'vec3<f32>' }]);
    }
  });

  it('returns a distinct binding mismatch with pass, parameter, and source span context', () => {
    const result = reflectMaterial(materialReflectionMismatchFixture);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('material-reflection-binding-mismatch');
      expect(result.error.detail).toMatchObject({
        pass: 'Forward',
        parameter: 'roughness',
        expected: 'f32',
        actual: 'vec4<f32>',
      });
      expect(result.error.detail.sourceSpan).toMatchObject({
        line: expect.any(Number),
        column: expect.any(Number),
      });
      expect(result.error.detail.context).toContain('roughness');
    }
  });
});

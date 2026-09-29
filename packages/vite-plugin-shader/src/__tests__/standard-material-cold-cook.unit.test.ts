import { resolve } from 'node:path';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack';
import { createBuiltinMaterialAsset } from '@forgeax/engine-shader';
import { createMaterialPackCooker } from '@forgeax/engine-shader-compiler';
import { describe, expect, it } from 'vitest';

describe('Standard material cold cook', () => {
  it.each([
    'forgeax_material::standard',
    'forgeax_material::pbr-skin',
    'forgeax::vfx-render.particles.mesh',
    'forgeax::vfx-render.particles.mesh-inputs',
  ])('retains the declared material interface without transmission: %s', async (module) => {
    const root = resolve(import.meta.dirname, '../../../shader/src');
    const particleRoot = resolve(import.meta.dirname, '../../../vfx-render/src/shaders');
    const material = createBuiltinMaterialAsset('standard');
    const passes = material.passes?.map((pass) => {
      const program = { ...pass.program, module };
      if (!module.startsWith('forgeax::vfx-render')) return { ...pass, program };
      // Particle mesh shaders own the Standard Surface ABI directly; they are
      // not Standard-root templates and therefore must not retain the root's
      // `moduleSlots.surface` selector when cold-cooked.
      const { moduleSlots: _moduleSlots, ...programWithoutSlots } = pass.program;
      return { ...pass, program: { ...programWithoutSlots, module } };
    });
    const draft = await createMaterialPackCooker([root, particleRoot]).cook({
      guid: '019f0000-0000-7000-8000-000000000101',
      source: {
        ...material,
        ...(passes === undefined ? {} : { passes }),
      },
    });
    // Standard roots publish ordinary/visible direct and scene-index artifacts;
    // the rigid Standard root also publishes ray-hit; particles retain their authored artifact.
    expect(Object.keys(draft.artifacts)).toHaveLength(
      module === 'forgeax_material::standard' ? 5 : module === 'forgeax_material::pbr-skin' ? 4 : 1,
    );
    const cooked = validateCookedMaterialRecord(
      (draft.payload as Record<string, unknown>).cooked,
    ).unwrap();
    const selections = cooked.programs.flatMap((program) => program.selections);
    if (!module.startsWith('forgeax::vfx-render')) {
      for (const visibleSurface of [false, true]) {
        expect(
          selections
            .filter(
              (selection) =>
                selection.context.pipeline !== 'ray' &&
                (selection.context.visibleSurface === true) === visibleSurface,
            )
            .map((selection) => selection.address),
        ).toEqual(['direct', 'scene-index']);
      }
    } else {
      expect(
        selections.every(
          (selection) =>
            selection.context.pipeline !== 'ray' && selection.context.visibleSurface !== true,
        ),
      ).toBe(true);
    }
  });
});

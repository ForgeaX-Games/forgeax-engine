import { readFileSync } from 'node:fs';
import type { ParticleStageResourceAccess, VfxGpuStageReflection } from '@forgeax/engine-vfx';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { VfxValidatedStage } from '../index.js';

type ReflectedAccess = VfxGpuStageReflection['resources'][number]['access'];
type ValidatedAccess = VfxValidatedStage['resources'][number]['access'];

const stagePlanSource = readFileSync(new URL('../feature/stage-plan.ts', import.meta.url), 'utf8');

describe('VFX validated stage resource access owner', () => {
  it('keeps reflected and final validated access equal to the authored owner', () => {
    expectTypeOf<ReflectedAccess>().toEqualTypeOf<ParticleStageResourceAccess>();
    expectTypeOf<ParticleStageResourceAccess>().toEqualTypeOf<ReflectedAccess>();
    expectTypeOf<ValidatedAccess>().toEqualTypeOf<ParticleStageResourceAccess>();
    expectTypeOf<ParticleStageResourceAccess>().toEqualTypeOf<ValidatedAccess>();
  });

  it('keeps the final projection derived from reflection without a second vocabulary', () => {
    expect(stagePlanSource).toContain(
      "readonly access: VfxGpuStageReflection['resources'][number]['access'];",
    );
    expect(stagePlanSource).not.toContain("readonly access: 'read' | 'write' | 'read-write';");
    expectTypeOf<'unknown-access'>().not.toExtend<ValidatedAccess>();
  });
});

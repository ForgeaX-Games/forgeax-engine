import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const stagePlanPath = resolve(import.meta.dirname, '../feature/stage-plan.ts');

describe('VFX managed stage execution seam', () => {
  it('owns readiness and validated-plan execution in the RenderFeature package', () => {
    const source = readFileSync(stagePlanPath, 'utf8');
    expect(source).toContain('validatedStagePlan');
    expect(source).toContain('stageReadiness');
    expect(source).toContain('stageOutput');
    expect(source).toContain('forgeax_vfx_stage_');
    expect(source).not.toContain('authorRawDispatch');
  });
});

import { describe, expect, it } from 'vitest';
import { projectStandardSurfacePasses } from '../assembly/material/surface-projection';
import { layerPlanFor, passFor, SURFACE_CASES } from './surface-standard-pipeline.fixture';

describe('Standard Surface render projection contract', () => {
  it('keeps physical roots Forward-only while base roots remain Deferred', () => {
    for (const surfaceCase of SURFACE_CASES) {
      const passes = projectStandardSurfacePasses({
        surfaceModule: surfaceCase.surfaceModule,
        values: surfaceCase.material.values ?? {},
        geometryVariant: 'skinned',
        lightingLane: 'clustered',
        alphaClip: true,
        layerPlan: layerPlanFor(surfaceCase),
      });
      expect(passes.some((entry) => entry.name === passFor(surfaceCase))).toBe(true);
      expect(passes[0]?.program.moduleSlots?.surface).toBe(surfaceCase.surfaceModule);
    }
  });
});

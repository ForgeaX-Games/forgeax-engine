import { describe, it } from 'vitest';
import { rasterCases, verifyRasterCase } from './material-raster-state-fixture';

describe('material raster state RHI Debug browser WebGPU evidence', () => {
  it.each(rasterCases)('$name', async (testCase) => {
    await verifyRasterCase(testCase);
  }, 60_000);
});

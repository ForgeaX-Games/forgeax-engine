import { describe, expect, it } from 'vitest';
import {
  observeBrowserGpuPassTimingDisabled,
  runBrowserGpuPassTiming,
} from './gpu-pass-timing-browser-runner.js';

const browserReady = typeof navigator !== 'undefined' && navigator.gpu !== undefined;

describe.skipIf(!browserReady)('GPU pass timing Browser dev-server runner', () => {
  it('returns the standard unavailable observation when GPU timing is disabled', async () => {
    const { requested, omitted } = await observeBrowserGpuPassTimingDisabled();
    expect(requested.timings).toMatchObject({
      status: 'unavailable',
      reason: { code: 'gpu-timing-not-enabled' },
    });
    expect(requested.timings).not.toHaveProperty('frame');
    expect(omitted.timings).toBeUndefined();
  });

  // Each timing case creates a fresh renderer. Its lavapipe initialization can
  // exceed Vitest's 15s default, including the raster-suppressed case below.
  // Both retain the same bounded startup allowance and three-frame assertions.
  it('keeps receipt facts and unsupported timing structured without stopping draw', {
    timeout: 30_000,
  }, async () => {
    const result = await runBrowserGpuPassTiming();
    expect(result.frames).toBe(3);
    if (result.supported) {
      expect(result.unavailable).toBe(false);
      expect(result.measuredPasses).toBeGreaterThan(0);
    } else {
      expect(result.unavailable).toBe(true);
      expect(result.measuredPasses).toBe(0);
    }
    expect(result.visible).toBe(true);
  });

  it('keeps raster suppression as a test-only falsifier, never timing evidence', {
    timeout: 30_000,
  }, async () => {
    const result = await runBrowserGpuPassTiming({ suppressRaster: true });
    expect(result.rasterSuppressed).toBe(true);
    expect(result.frames).toBe(3);
    if (result.supported) expect(result.measuredPasses).toBeGreaterThan(0);
  });
});

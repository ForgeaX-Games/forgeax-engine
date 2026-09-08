import type { RhiCaps } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import type { RenderFeature } from '../features/types';

const supportedCaps: Readonly<RhiCaps> = {
  backendKind: 'null',
  compute: true,
  timestampQuery: false,
  timestampPeriodNanoseconds: null,
  indirectDrawing: false,
  textureCompressionBc: false,
} as RhiCaps;

const missingCaps: Readonly<RhiCaps> = { ...supportedCaps, compute: false };

function preparedFeature(): RenderFeature<{ readonly draw: boolean }> {
  return {
    identity: 'synthetic.capability',
    requiredCapabilities: ['compute'],
    extract: () => ok({ draw: true }),
    plan: () => ok({ resources: [], passes: [] }),
  };
}

describe('prepared graphics capability projection', () => {
  it('projects supported capability into an accepted machine-readable operation', () => {
    const host = createRenderFeatureHost([preparedFeature()]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: supportedCaps,
    });

    expect(result.errors).toEqual([]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]?.plan).toEqual({ resources: [], passes: [] });
    expect(host.diagnostics()[0]?.status).toBe('active');
  });

  it('returns a structured capability failure without a silent operation', () => {
    const host = createRenderFeatureHost([preparedFeature()]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: missingCaps,
    });

    expect(result.plans).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      code: 'render-feature-capability-missing',
      expected: expect.stringContaining('compute'),
      hint: expect.stringContaining('disable'),
      detail: {
        featureIdentity: 'synthetic.capability',
        capability: 'compute',
      },
    });
    expect(host.diagnostics()[0]?.status).toBe('disabled');
  });
});

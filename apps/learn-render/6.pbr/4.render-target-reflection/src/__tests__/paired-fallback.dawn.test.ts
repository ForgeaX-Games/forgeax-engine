import browserSchema from '../../../../../../schemas/ssr-fallback/browser/manifest.schema.json';
import dawnSchema from '../../../../../../schemas/ssr-fallback/dawn/manifest.schema.json';
import { REFLECTION_FALLBACK_EXPECTATION_IDS } from '../../scripts/ssr-fallback-evidence.mjs';
import { describe, expect, it } from 'vitest';

describe('SSR fallback paired Dawn manifest contract', () => {
  it('keeps Browser and Dawn schemas aligned while retaining distinct lane constants', () => {
    expect(dawnSchema.required).toEqual(browserSchema.required);
    expect(dawnSchema.properties.lane).toEqual({ const: 'dawn' });
    expect(browserSchema.properties.lane).toEqual({ const: 'browser' });
    expect(dawnSchema.$defs.fixture.properties.frames).toEqual({ type: 'integer', minimum: 60 });
    expect(dawnSchema.$defs.thresholds.properties.linearHdrAbsErrorMax).toEqual({ const: 0.05 });
    expect(dawnSchema.$defs.thresholds.properties.hdrLumaRelativeErrorMax).toEqual({ const: 0.02 });
    expect(REFLECTION_FALLBACK_EXPECTATION_IDS).toHaveLength(9);
    expect(new Set(REFLECTION_FALLBACK_EXPECTATION_IDS).size).toBe(9);
  });

  it('does not admit an old identity as paired evidence', () => {
    const identity = {
      sourceHead: 'current-source-head',
      sourceTree: 'current-source-tree',
      lockSha256: 'current-lock',
      buildSha256: 'current-build',
    };
    const oldIdentity = { ...identity, buildSha256: 'old-build' };
    expect(identity).not.toEqual(oldIdentity);
  });
});

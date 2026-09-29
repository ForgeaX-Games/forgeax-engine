import { describe, expect, it } from 'vitest';
import { standardPbrColorFormats } from '../pbr-pipeline';
import {
  commitReflectionFallbackGraph,
  createReflectionFallbackGraphRoster,
} from '../record/typed-frame-graph';

describe('reflection fallback typed graph', () => {
  it('does no MRT work when fallback demand is absent', () => {
    const roster = createReflectionFallbackGraphRoster({ fallbackDemand: false });
    expect(roster).toEqual({
      enabled: false,
      attachments: [],
      passes: [],
      bindings: [],
      historyCount: 0,
      temporalDemand: 0,
    });
  });

  it('declares one linear-HDR fallback attachment only on demand', () => {
    const roster = createReflectionFallbackGraphRoster({ fallbackDemand: true });
    expect(roster.enabled).toBe(true);
    expect(roster.attachments).toEqual(['reflection-fallback-linear-hdr']);
    expect(roster.passes).toEqual(['standard-main']);
    expect(roster.bindings).toEqual(['reflection-fallback-output']);
    expect(roster.historyCount).toBe(0);
    expect(roster.temporalDemand).toBe(0);
    expect(JSON.stringify(roster)).not.toMatch(/texture|view|handle/i);
  });

  it('derives a second attachment only for an admitted fallback draw', () => {
    expect(standardPbrColorFormats('rgba16float', false)).toEqual(['rgba16float']);
    expect(standardPbrColorFormats('rgba16float', true)).toEqual(['rgba16float', 'rgba16float']);
  });

  it.each([
    ['compile', 'compile-failed'],
    ['encode', 'encode-failed'],
    ['submit', 'submit-failed'],
  ] as const)('keeps candidate invisible when %s fails', (_stage, reason) => {
    const committed = commitReflectionFallbackGraph(
      {
        generation: 4,
        source: 'probe',
        roster: createReflectionFallbackGraphRoster({ fallbackDemand: true }),
      },
      { ok: false, reason },
    );
    expect(committed.visible).toBe(false);
    expect(committed.generation).toBe(0);
  });

  it('commits a read-only detached graph result after a successful submit', () => {
    const committed = commitReflectionFallbackGraph(
      {
        generation: 4,
        source: 'probe',
        roster: createReflectionFallbackGraphRoster({ fallbackDemand: true }),
      },
      { ok: true },
    );
    expect(committed).toEqual({ visible: true, generation: 4, source: 'probe' });
    expect(committed).not.toHaveProperty('texture');
    expect(committed).not.toHaveProperty('view');
  });
});

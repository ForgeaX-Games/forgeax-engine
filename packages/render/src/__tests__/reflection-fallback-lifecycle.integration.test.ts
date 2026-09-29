import { describe, expect, it } from 'vitest';
import {
  commitReflectionFallbackGraph,
  createReflectionFallbackGraphRoster,
} from '../record/typed-frame-graph';

describe('reflection fallback lifecycle', () => {
  it('does not publish stale or failed candidates', () => {
    const roster = createReflectionFallbackGraphRoster({ fallbackDemand: true });
    const failed = commitReflectionFallbackGraph(
      { generation: 3, source: 'probe', roster },
      { ok: false, reason: 'submit-failed' },
    );
    const stale = commitReflectionFallbackGraph(
      { generation: 2, source: 'probe', roster },
      { ok: false, reason: 'encode-failed' },
    );
    expect(failed.visible).toBe(false);
    expect(stale.visible).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { runVisibilityDawnSmoke } from '../scripts/smoke-dawn.mjs';

describe('entity visibility Dawn smoke', () => {
  it('keeps main, shadow, and visible-child criteria true for 300 frames', async () => {
    const result = await runVisibilityDawnSmoke({ frames: 300 });
    expect(result.backend).toBe('webgpu');
    expect(result.frames).toBeGreaterThanOrEqual(300);
    expect(result.targetRed.baseline).toBeGreaterThan(80);
    expect(result.targetRed.hidden).toBeLessThan(result.targetRed.baseline * 0.05);
    expect(result.targetRed.restored).toBeGreaterThan(result.targetRed.baseline * 0.8);
    expect(result.childColors.blue).toBeGreaterThan(60);
    expect(result.childColors.gold).toBeGreaterThan(5);
    expect(result.hiddenShadowDelta.changedPixels).toBeGreaterThan(30);
    expect(result.hiddenShadowDelta.meanL1).toBeGreaterThan(5);
    expect(result.restoredShadowDelta.changedPixels).toBeGreaterThan(30);
    expect(result.restoredShadowDelta.meanL1).toBeGreaterThan(5);
    expect(result.hiddenTargetEffective).toBe('hidden');
    expect(result.restoredTargetEffective).toBe('visible');
    expect(result.visibleChildEffective).toBe('visible');
    expect(result.inheritedDescendantEffective).toBe('visible');
    expect(result.hiddenVisibilityStats).toBeGreaterThan(0);
    expect(result.restoredShadowResourceReady).toBe(true);
    expect(result.restoredShadowPasses.length).toBeGreaterThan(0);
    expect(result.errors).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { createFullscreenRenderFeature } from '../features/fullscreen';
import { freezeRenderFeaturePlan } from '../features/plan';

describe('fullscreen RenderFeature plan', () => {
  it('keeps the cooked effect on the Standard post-stage owner', () => {
    const feature = createFullscreenRenderFeature({
      identity: 'test::fullscreen',
      source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }',
      params: { byteSize: 4, defaultValue: new Uint8Array([1, 0, 0, 0]) },
    });
    const planned = feature.plan(undefined, {
      caps: {} as never,
      frame: { frameNumber: 1 },
      generation: 1,
      targets: [{ name: 'scene-color', kind: 'color', format: 'rgba16float', sampleCount: 1 }],
    });

    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(
      freezeRenderFeaturePlan(feature.identity, planned.value, [
        { name: 'scene-color', kind: 'color', format: 'rgba16float', sampleCount: 1 },
      ]).ok,
    ).toBe(true);
    expect(planned.value.resources[0]).toMatchObject({
      kind: 'fullscreen-program',
      source: '@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1); }',
    });
    expect(planned.value.passes).toEqual([]);
  });
});

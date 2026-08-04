import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import type { RenderFeature } from '../features/types';

describe('render feature visibility report deduplication', () => {
  it('deduplicates a built-in and feature report by World identity and entity', () => {
    const world = new World();
    const feature: RenderFeature<{ readonly count: number }> = {
      identity: 'synthetic.visibility-report',
      extract: (context) => {
        context.reportHiddenEntity?.({ world, entity: 3 as never });
        return ok({ count: context.worlds.length });
      },
      prepare: () => ok(undefined),
      contribute: () => ok(undefined),
    };
    const host = createRenderFeatureHost([feature]).unwrap();

    const result = runRenderFeatureFrame(host, {
      worlds: [world],
      owner: 0,
      frameNumber: 1,
      caps: {} as never,
      hiddenEntityReports: [{ world, entity: 3 as never }],
    });

    expect(result.hiddenEntityReports).toEqual([{ world, entity: 3 }]);
  });

  it('keeps equal entity handles from different Worlds as separate reports', () => {
    const first = new World();
    const second = new World();
    const feature: RenderFeature<{ readonly count: number }> = {
      identity: 'synthetic.visibility-worlds',
      extract: (context) => {
        context.reportHiddenEntity?.({ world: first, entity: 1 as never });
        context.reportHiddenEntity?.({ world: second, entity: 1 as never });
        return ok({ count: context.worlds.length });
      },
      prepare: () => ok(undefined),
      contribute: () => ok(undefined),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const result = runRenderFeatureFrame(host, {
      worlds: [first, second],
      owner: 0,
      frameNumber: 1,
      caps: {} as never,
    });

    expect(result.hiddenEntityReports).toHaveLength(2);
    expect(result.hiddenEntityReports[0]?.world).toBe(first);
    expect(result.hiddenEntityReports[1]?.world).toBe(second);
  });
});

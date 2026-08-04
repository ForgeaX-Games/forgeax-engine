import { World } from '@forgeax/engine-ecs';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import type { RenderFeature, RenderFeatureHiddenEntityReport } from '../features/types';

describe('render feature visibility context', () => {
  it('passes the same batch visibility context to every feature', () => {
    const world = new World();
    let receivedSnapshots: unknown;
    const feature: RenderFeature<{ readonly count: number }> = {
      identity: 'synthetic.visibility-context',
      extract: (context) => {
        receivedSnapshots = context.visibilitySnapshots;
        context.reportHiddenEntity?.({ world, entity: 7 as never });
        return ok({ count: context.worlds.length });
      },
      prepare: () => ok(undefined),
      contribute: () => ok(undefined),
    };
    const host = createRenderFeatureHost([feature]).unwrap();
    const snapshots = [{ world, snapshot: {} as never }];
    const builtIn: RenderFeatureHiddenEntityReport = { world, entity: 7 as never };

    const result = runRenderFeatureFrame(host, {
      worlds: [world],
      owner: 0,
      frameNumber: 1,
      caps: {} as never,
      visibilitySnapshots: snapshots,
      hiddenEntityReports: [builtIn],
    });

    expect(receivedSnapshots).toBe(snapshots);
    expect(result.hiddenEntityReports).toHaveLength(1);
    expect(result.hiddenEntityReports[0]).toEqual(builtIn);
  });
});

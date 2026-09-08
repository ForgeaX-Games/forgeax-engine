import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import type { RenderFeature } from '../features/types';

const caps = (compute: boolean): Readonly<RhiCaps> => ({ compute }) as unknown as RhiCaps;

describe('render feature retry rules', () => {
  it('retries ordinary failures on the next frame and keeps latest error structured', () => {
    let attempts = 0;
    const feature: RenderFeature<{ readonly frame: number }> = {
      identity: 'synthetic.retry',
      extract: ({ frameNumber }) => ok({ frame: frameNumber }),
      plan: () => {
        attempts += 1;
        if (attempts === 1) {
          return err(new RenderFeatureStageFailedError('synthetic.retry', 0, 'plan', 'next-frame'));
        }
        return ok({ resources: [], passes: [] });
      },
    };
    const host = createRenderFeatureHost([feature], caps(true)).unwrap();

    const failed = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: caps(true),
    });
    const error = failed.errors[0];
    expect(error?.code).toBe('render-feature-stage-failed');
    if (error?.code === 'render-feature-stage-failed') {
      expect(error.detail).toMatchObject({
        featureIdentity: 'synthetic.retry',
        stage: 'plan',
        recovery: 'next-frame',
      });
    }

    const retried = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 2,
      caps: caps(true),
    });
    expect(retried.errors).toEqual([]);
    expect(host.diagnostics()[0]?.latestError).toBeUndefined();
    expect(host.diagnostics()[0]?.status).toBe('active');
  });

  it('does not retry a disabled feature until recover makes its capability available', () => {
    const feature: RenderFeature<{ readonly frame: number }> = {
      identity: 'synthetic.capability-retry',
      requiredCapabilities: ['compute'],
      extract: ({ frameNumber }) => ok({ frame: frameNumber }),
      plan: () => ok({ resources: [], passes: [] }),
    };
    const host = createRenderFeatureHost([feature], caps(false)).unwrap();

    runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: caps(false),
    });
    expect(
      runRenderFeatureFrame(host, {
        worlds: [],
        owner: 0,
        frameNumber: 2,
        caps: caps(true),
      }).stageEvents,
    ).toEqual([]);

    expect(host.recover({ frameNumber: 3, caps: caps(true) })).toEqual(ok(undefined));
    expect(
      runRenderFeatureFrame(host, {
        worlds: [],
        owner: 0,
        frameNumber: 3,
        caps: caps(true),
      }).stageEvents,
    ).toHaveLength(2);
  });
});

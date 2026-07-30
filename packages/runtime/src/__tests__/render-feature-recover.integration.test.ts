import type { RenderFeature } from '@forgeax/engine-render';
import {
  createRenderFeatureHost,
  RenderFeatureStageFailedError,
  runRenderFeatureFrame,
} from '@forgeax/engine-render/internal';
import type { RhiCaps } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

const caps = (compute: boolean): Readonly<RhiCaps> => ({ compute }) as unknown as RhiCaps;

function recoverableFeature(calls: string[]): RenderFeature<{ readonly frame: number }> {
  return {
    identity: 'synthetic.recoverable',
    requiredCapabilities: ['compute'],
    extract: ({ frameNumber }) => {
      calls.push(`extract:${frameNumber}`);
      return ok({ frame: frameNumber });
    },
    prepare: (data) => {
      calls.push(`prepare:${data.frame}`);
      return ok(undefined);
    },
    contribute: (data) => {
      calls.push(`contribute:${data.frame}`);
      return ok(undefined);
    },
    recover: ({ frame }) => {
      calls.push(`recover:${frame.frameNumber}`);
      return ok(undefined);
    },
  };
}

describe('render feature recovery lifecycle', () => {
  it('retries failed slots, gates missing capabilities, and re-evaluates on recover', () => {
    const calls: string[] = [];
    const host = createRenderFeatureHost([recoverableFeature(calls)], caps(true)).unwrap();

    const first = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: caps(true),
    });
    expect(first.stageEvents.map((event) => event.stage)).toEqual([
      'extract',
      'prepare',
      'contribute',
    ]);

    host.setStatus(
      'synthetic.recoverable',
      'failed',
      new RenderFeatureStageFailedError('synthetic.recoverable', 0, 'prepare', 'next-frame'),
    );
    const retry = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 2,
      caps: caps(true),
    });
    expect(retry.errors).toEqual([]);
    expect(calls.slice(-3)).toEqual(['extract:2', 'prepare:2', 'contribute:2']);

    host.setStatus('synthetic.recoverable', 'disabled');
    const skipped = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 3,
      caps: caps(true),
    });
    expect(skipped.stageEvents).toEqual([]);

    const recovered = host.recover({ frameNumber: 4, caps: caps(true) });
    expect(recovered).toEqual(ok(undefined));
    expect(calls.at(-1)).toBe('recover:4');

    const resumed = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 4,
      caps: caps(true),
    });
    expect(resumed.errors).toEqual([]);
    expect(resumed.stageEvents).toHaveLength(3);
  });

  it('keeps registration through a pipeline switch and makes dispose terminal', () => {
    const calls: string[] = [];
    const host = createRenderFeatureHost([recoverableFeature(calls)], caps(true)).unwrap();

    const beforeSwitch = host.features;
    const afterSwitch = host.features;
    expect(afterSwitch).toBeTruthy();
    expect(afterSwitch[0]?.identity).toBe(beforeSwitch[0]?.identity);

    expect(host.dispose()).toEqual(ok(undefined));
    expect(host.dispose()).toEqual(ok(undefined));
    const afterDispose = host.recover({ frameNumber: 1, caps: caps(true) });
    expect(afterDispose.ok).toBe(false);
    if (!afterDispose.ok && afterDispose.error.code === 'render-feature-stage-failed') {
      expect(afterDispose.error.code).toBe('render-feature-stage-failed');
      expect(afterDispose.error.detail.stage).toBe('recover');
    }
    expect(
      runRenderFeatureFrame(host, {
        worlds: [],
        owner: 0,
        frameNumber: 2,
        caps: caps(true),
      }).stageEvents,
    ).toEqual([]);
    expect(calls).toEqual([]);
  });
});

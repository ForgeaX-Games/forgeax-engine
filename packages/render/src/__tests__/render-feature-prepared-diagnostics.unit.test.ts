import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import type { RenderFeature } from '../features/types';

const caps = (compute: boolean): Readonly<RhiCaps> =>
  ({ backendKind: 'null', compute }) as unknown as RhiCaps;

function feature(
  mode: 'healthy' | 'failed',
  recoverCalls: number[],
): RenderFeature<{ readonly ready: true }> {
  return {
    identity: `synthetic.diagnostics.${mode}`,
    requiredCapabilities: ['compute'],
    extract: () => ok({ ready: true }),
    prepare: () =>
      mode === 'failed'
        ? err(
            new RenderFeatureStageFailedError(
              `synthetic.diagnostics.${mode}`,
              0,
              'prepare',
              'next-frame',
            ),
          )
        : ok(undefined),
    contribute: () => ok(undefined),
    recover: () => {
      recoverCalls.push(1);
      return ok(undefined);
    },
  };
}

describe('render feature prepared diagnostics', () => {
  it('projects disabled and failed states with code-directed recovery data', () => {
    const recoverCalls: number[] = [];
    const disabledHost = createRenderFeatureHost([feature('healthy', recoverCalls)]).unwrap();
    runRenderFeatureFrame(disabledHost, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: caps(false),
    });
    const disabled = disabledHost.diagnostics()[0];
    expect(disabled).toMatchObject({
      status: 'disabled',
      latestError: {
        code: 'render-feature-capability-missing',
        detail: { capability: 'compute' },
      },
    });
    expect(disabled?.latestError?.expected).toContain('compute');
    expect(disabled?.latestError?.hint).toContain('disable');

    const failedHost = createRenderFeatureHost([feature('failed', recoverCalls)]).unwrap();
    runRenderFeatureFrame(failedHost, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: caps(true),
    });
    const failed = failedHost.diagnostics()[0];
    expect(failed).toMatchObject({
      status: 'failed',
      latestError: {
        code: 'render-feature-stage-failed',
        detail: { stage: 'prepare', recovery: 'next-frame' },
      },
    });
    expect(failed?.latestError?.hint).toContain('next frame');
  });

  it('makes disposed diagnostics terminal and keeps repeated lifecycle calls side-effect free', () => {
    const recoverCalls: number[] = [];
    const host = createRenderFeatureHost([feature('healthy', recoverCalls)]).unwrap();
    expect(host.recover({ frameNumber: 2, caps: caps(true) })).toEqual(ok(undefined));
    expect(host.recover({ frameNumber: 2, caps: caps(true) })).toEqual(ok(undefined));
    expect(recoverCalls).toHaveLength(1);

    expect(host.dispose()).toEqual(ok(undefined));
    expect(host.dispose()).toEqual(ok(undefined));
    const diagnostics = host.diagnostics()[0];
    expect(diagnostics).toMatchObject({
      identity: 'synthetic.diagnostics.healthy',
      status: 'disposed',
    });
    const recoverAfterDispose = host.recover({ frameNumber: 3, caps: caps(true) });
    expect(recoverAfterDispose.ok).toBe(false);
    if (!recoverAfterDispose.ok) {
      expect(recoverAfterDispose.error).toMatchObject({
        code: 'render-feature-stage-failed',
        detail: { stage: 'recover', recovery: 'registration' },
      });
      expect(recoverAfterDispose.error.hint).toContain('registration');
    }
  });
});

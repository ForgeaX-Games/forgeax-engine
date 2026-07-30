import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { RenderFeatureStageFailedError } from '../errors/render';
import { createRenderFeatureHost, type RenderFeatureOwnedResource } from '../features/host';
import type { RenderFeature } from '../features/types';

function feature(identity: string): RenderFeature<{ readonly ready: true }> {
  return {
    identity,
    extract: () => ok({ ready: true }),
    prepare: () => ok(undefined),
    contribute: () => ok(undefined),
  };
}

function resource(
  name: string,
  release: () => ReturnType<RenderFeatureOwnedResource['release']>,
): RenderFeatureOwnedResource {
  return {
    handle: { __renderFeatureResource: Symbol(name) } as never,
    release,
  };
}

describe('render feature construction ownership', () => {
  it('rejects duplicate identity before a host can acquire resources', () => {
    const result = createRenderFeatureHost([
      feature('synthetic.shared'),
      feature('synthetic.shared'),
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === 'render-feature-registration-conflict') {
      expect(result.error.code).toBe('render-feature-registration-conflict');
      expect(result.error.detail.featureIdentity).toBe('synthetic.shared');
    }
  });

  it('cleans transferred resources in registration order and isolates failures', () => {
    const host = createRenderFeatureHost([
      feature('synthetic.first'),
      feature('synthetic.second'),
    ]).unwrap();
    const released: string[] = [];

    host.registerResource(
      'synthetic.first',
      resource('first', () => {
        released.push('first');
        return ok(undefined);
      }),
    );
    host.registerResource(
      'synthetic.second',
      resource('second-fails', () => {
        released.push('second-fails');
        return err(
          new RenderFeatureStageFailedError('synthetic.second', 1, 'dispose', 'renderer-recover'),
        );
      }),
    );
    host.registerResource(
      'synthetic.second',
      resource('second-after-failure', () => {
        released.push('second-after-failure');
        return ok(undefined);
      }),
    );

    const disposed = host.dispose();

    expect(released).toEqual(['first', 'second-fails', 'second-after-failure']);
    expect(disposed.ok).toBe(false);
    if (!disposed.ok && disposed.error.code === 'render-feature-stage-failed') {
      expect(disposed.error.code).toBe('render-feature-stage-failed');
      expect(disposed.error.detail.stage).toBe('dispose');
      const cleanupFailures = disposed.error.detail.cleanupFailures;
      expect(cleanupFailures).toHaveLength(1);
      if (cleanupFailures !== undefined) {
        expect(cleanupFailures[0]?.featureIdentity).toBe('synthetic.second');
      }
    }

    expect(host.dispose()).toEqual(ok(undefined));
    expect(released).toEqual(['first', 'second-fails', 'second-after-failure']);
  });
});

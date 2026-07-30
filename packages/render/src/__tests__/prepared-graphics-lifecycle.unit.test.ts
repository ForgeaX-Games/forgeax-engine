import type { RhiCaps } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  createRenderFeatureHost,
  runRenderFeatureFrame,
  settlePreparedGraphicsCompletion,
} from '../features/host';
import { createPreparedGraphicsStore } from '../features/prepared-graphics-store';
import type { RenderFeature } from '../features/types';

const caps = { backendKind: 'null' } as unknown as Readonly<RhiCaps>;

function preparedFeature(recoverCalls: number[]): RenderFeature<{ readonly ready: true }> {
  let pipeline: { readonly kind: 'pipeline'; readonly generation: number } | undefined;
  let bindings: { readonly kind: 'bindings'; readonly generation: number } | undefined;
  let vertices: { readonly kind: 'vertex-data'; readonly generation: number } | undefined;
  return {
    identity: 'synthetic.lifecycle',
    extract: () => ok({ ready: true }),
    prepare: (_data, context) => {
      const result = context.graphics.preparePipeline('pipeline', {
        shader: 'synthetic.shader',
        vertexLayout: 'position',
        colorFormats: ['rgba8unorm'],
      });
      if (!result.ok) return result;
      pipeline = result.value;
      const bindingsResult = context.graphics.prepareBindings('bindings', {
        pipeline: result.value,
        values: {},
      });
      if (!bindingsResult.ok) return bindingsResult;
      bindings = bindingsResult.value;
      const verticesResult = context.graphics.prepareVertexData('vertices', {
        layout: 'position',
        data: [0, 0, 0],
      });
      if (!verticesResult.ok) return verticesResult;
      vertices = verticesResult.value;
      return ok(undefined);
    },
    contribute: (_data, context) => {
      if (pipeline === undefined || bindings === undefined || vertices === undefined) {
        return err(new Error('prepared state missing') as never);
      }
      context.staging.addResource('color', { kind: 'texture', lifetime: 'transient' });
      return context.staging.addGraphicsPass('prepared', {
        attachments: {
          colors: [{ resource: 'color', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' }],
        },
        draws: [
          {
            kind: 'draw',
            pipeline,
            bindings: [bindings],
            vertexData: [{ slot: 0, resource: vertices }],
            command: { vertexCount: 3, instanceCount: 1 },
          },
        ],
      });
    },
    recover: () => {
      recoverCalls.push(1);
      return ok(undefined);
    },
  };
}

describe('prepared graphics lifecycle ownership', () => {
  it('aborts partial preparation without changing committed state', () => {
    const store = createPreparedGraphicsStore();
    const initial = store.beginFrame('synthetic.lifecycle', 1);
    initial.prepare('pipeline', 'pipeline', { signature: 'v1' });
    initial.commit();

    const failed = store.beginFrame('synthetic.lifecycle', 2);
    failed.prepare('bindings', 'bindings', { signature: 'v2' });
    failed.abort();

    expect(store.snapshot('synthetic.lifecycle')).toMatchObject({
      generation: 1,
      items: [{ kind: 'pipeline', name: 'pipeline' }],
    });
    expect(failed.overlayItems()).toEqual([]);
  });

  it('re-prepares after recovery and makes repeated recovery idempotent', () => {
    const recoverCalls: number[] = [];
    const host = createRenderFeatureHost([preparedFeature(recoverCalls)]).unwrap();
    const first = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      generation: 1,
      caps,
    });
    expect(first.errors).toEqual([]);

    expect(host.recover({ frameNumber: 2, caps })).toEqual(ok(undefined));
    expect(host.recover({ frameNumber: 2, caps })).toEqual(ok(undefined));
    const recovered = runRenderFeatureFrame(host, {
      worlds: [],
      owner: 0,
      frameNumber: 3,
      generation: 2,
      caps,
    });

    expect(recoverCalls).toHaveLength(1);
    expect(recovered.errors).toEqual([]);
    expect(host.features[0]?.identity).toBe('synthetic.lifecycle');
    expect(host.diagnostics()[0]?.status).toBe('active');
  });

  it('releases registered resources once and keeps dispose terminal', () => {
    const host = createRenderFeatureHost([preparedFeature([])]).unwrap();
    let releases = 0;
    host.registerResource('synthetic.lifecycle', {
      handle: {} as never,
      release: () => {
        releases += 1;
        return ok(undefined);
      },
    });

    expect(host.dispose()).toEqual(ok(undefined));
    expect(host.dispose()).toEqual(ok(undefined));
    expect(releases).toBe(1);
    expect(host.recover({ frameNumber: 4, caps }).ok).toBe(false);
    expect(host.diagnostics()[0]?.status).toBe('disposed');
  });

  it('releases a prepared batch that never reached queue submission during recovery', () => {
    const host = createRenderFeatureHost([preparedFeature([])]).unwrap();
    let releases = 0;
    const lease = {
      release: () => {
        releases += 1;
        return ok(undefined);
      },
    };
    const batch = host.retainPreparedGraphics('synthetic.lifecycle', [lease]).unwrap();

    expect(host.recover({ frameNumber: 5, caps })).toEqual(ok(undefined));
    expect(releases).toBe(1);
    expect(host.retirePreparedGraphics([batch])).toEqual(ok(undefined));
    expect(releases).toBe(1);
  });

  it('keeps submitted batches alive through recovery and dispose until late completion', () => {
    const host = createRenderFeatureHost([preparedFeature([])]).unwrap();
    let releases = 0;
    const lease = {
      release: () => {
        releases += 1;
        return ok(undefined);
      },
    };
    const batch = host.retainPreparedGraphics('synthetic.lifecycle', [lease]).unwrap();

    host.markPreparedGraphicsSubmitted([batch]);
    expect(host.recover({ frameNumber: 6, caps })).toEqual(ok(undefined));
    expect(releases).toBe(0);
    expect(host.dispose()).toEqual(ok(undefined));
    expect(releases).toBe(0);

    expect(host.retirePreparedGraphics([batch])).toEqual(ok(undefined));
    expect(host.retirePreparedGraphics([batch])).toEqual(ok(undefined));
    expect(releases).toBe(1);
  });

  it('recovers submitted batches when queue completion rejects and reports release errors', async () => {
    const host = createRenderFeatureHost([preparedFeature([])]).unwrap();
    let releases = 0;
    const releaseError = new Error('prepared release failed');
    const firstLease = {
      release: () => {
        releases += 1;
        return ok(undefined);
      },
    };
    const secondLease = {
      release: () => {
        releases += 1;
        return err(releaseError as never);
      },
    };
    const first = host.retainPreparedGraphics('synthetic.lifecycle', [firstLease]).unwrap();
    const second = host.retainPreparedGraphics('synthetic.lifecycle', [secondLease]).unwrap();
    host.markPreparedGraphicsSubmitted([first, second]);

    const errors: unknown[] = [];
    const completion = Promise.reject(new Error('queue completion unavailable'));
    settlePreparedGraphicsCompletion(host, [first, second], completion, (error) => {
      errors.push(error);
    });
    await completion.catch(() => undefined);
    await Promise.resolve();

    expect(releases).toBe(2);
    expect(errors).toEqual([releaseError]);
    expect(host.retirePreparedGraphics([first, second])).toEqual(ok(undefined));
    expect(releases).toBe(2);
  });
});

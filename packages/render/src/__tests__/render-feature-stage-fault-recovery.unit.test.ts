import type { RhiCaps, RhiDevice } from '@forgeax/engine-rhi';
import { err, ok } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import {
  type RenderError,
  RenderFeatureDrawRecordingFailedError,
  RenderFeaturePreparationFailedError,
  RenderFeatureStageFailedError,
} from '../errors/render';
import {
  createRenderFeatureHost,
  type RenderFeatureHost,
  runRenderFeatureFrame,
} from '../features/host';
import type { RenderFeature } from '../features/types';
import { createPreparedGraphicsResolver } from '../prepare/prepared-graphics-resolver';
import { recordResolvedRenderFeatureGraphicsPass } from '../record/frame-targets';

const caps = { backendKind: 'null' } as unknown as Readonly<RhiCaps>;

type Fault = 'create' | 'prepared-resource' | 'draw-recording';

function healthyFeature(probe: { prepare: number; contribute: number }): RenderFeature<{
  readonly ready: true;
}> {
  return {
    identity: 'synthetic.m10.healthy',
    extract: () => ok({ ready: true }),
    prepare: () => {
      probe.prepare += 1;
      return ok(undefined);
    },
    contribute: (_data, context) => {
      probe.contribute += 1;
      context.staging.addResource('target', { kind: 'texture', lifetime: 'transient' });
      return context.staging.addPass('pass', { reads: [], writes: ['target'] });
    },
  };
}

function faultyFeature(
  fault: Fault,
  probe: { prepare: number; contribute: number },
): { readonly feature: RenderFeature<{ readonly ready: true }>; readonly repair: () => void } {
  let repaired = false;
  const identity = `synthetic.m10.${fault}`;
  const failure = (): RenderError => {
    switch (fault) {
      case 'create':
        return new RenderFeatureStageFailedError(identity, 1, 'prepare', 'next-frame');
      case 'prepared-resource':
        return new RenderFeaturePreparationFailedError(
          identity,
          1,
          'prepareVertexData',
          'vertex-data',
          `${identity}::triangle`,
          'backend-upload-failed',
          'next-frame',
        );
      case 'draw-recording':
        return new RenderFeatureDrawRecordingFailedError(
          identity,
          1,
          'recordDraw',
          'vertex-data',
          'backend-recording-failed',
          'synthetic backend rejected setVertexBuffer',
          'next-frame',
        );
    }
  };
  return {
    feature: {
      identity,
      extract: () => ok({ ready: true }),
      prepare: () => {
        probe.prepare += 1;
        if (!repaired && fault !== 'draw-recording') return err(failure());
        return ok(undefined);
      },
      contribute: (_data, context) => {
        probe.contribute += 1;
        if (!repaired && fault === 'draw-recording') return err(failure());
        context.staging.addResource('target', { kind: 'texture', lifetime: 'transient' });
        return context.staging.addPass('pass', { reads: [], writes: ['target'] });
      },
    },
    repair: () => {
      repaired = true;
    },
  };
}

function frame(host: RenderFeatureHost, frameNumber: number) {
  return runRenderFeatureFrame(host, {
    worlds: [],
    owner: 0,
    frameNumber,
    caps,
  });
}

describe('RenderFeature stage fault recovery lifecycle', () => {
  it.each<Fault>([
    'create',
    'prepared-resource',
    'draw-recording',
  ])('keeps a healthy sibling visible and clears feature-local %s diagnostics after repair', (fault) => {
    const healthyProbe = { prepare: 0, contribute: 0 };
    const faultyProbe = { prepare: 0, contribute: 0 };
    const faulty = faultyFeature(fault, faultyProbe);
    const healthy = healthyFeature(healthyProbe);
    const host = createRenderFeatureHost([healthy, faulty.feature], caps).unwrap();
    let releaseCount = 0;
    host.registerResource(`synthetic.m10.${fault}`, {
      handle: { __renderFeatureResource: Symbol(fault) } as never,
      release: () => {
        releaseCount += 1;
        return ok(undefined);
      },
    });

    const first = frame(host, 1);
    const firstError = first.errors.find((error) => {
      switch (error.code) {
        case 'render-feature-stage-failed':
        case 'render-feature-preparation-failed':
        case 'render-feature-draw-recording-failed':
          return error.detail.featureIdentity.includes(fault);
        default:
          return false;
      }
    });
    expect(firstError).toBeDefined();
    expect(firstError).toMatchObject({
      code:
        fault === 'create'
          ? 'render-feature-stage-failed'
          : fault === 'prepared-resource'
            ? 'render-feature-preparation-failed'
            : 'render-feature-draw-recording-failed',
      detail: { featureIdentity: `synthetic.m10.${fault}`, order: 1 },
    });
    expect(firstError?.hint.length).toBeGreaterThan(0);
    expect(first.contributions.map((entry) => entry.featureIdentity)).toEqual([
      'synthetic.m10.healthy',
    ]);
    expect(host.diagnostics().map((entry) => entry.status)).toEqual(['active', 'failed']);
    expect(host.diagnostics()[1]?.latestError).toMatchObject({
      detail: { featureIdentity: `synthetic.m10.${fault}` },
    });

    faulty.repair();
    const second = frame(host, 2);
    expect(second.errors).toEqual([]);
    expect(second.contributions.map((entry) => entry.featureIdentity)).toEqual([
      'synthetic.m10.healthy',
      `synthetic.m10.${fault}`,
    ]);
    expect(host.diagnostics().map((entry) => entry.status)).toEqual(['active', 'active']);
    expect(host.diagnostics()[1]?.latestError).toBeUndefined();
    expect(healthyProbe.contribute).toBe(2);
    expect(faultyProbe.prepare).toBe(2);
    expect(faultyProbe.contribute).toBe(fault === 'draw-recording' ? 2 : 1);

    expect(host.dispose()).toEqual(ok(undefined));
    expect(host.dispose()).toEqual(ok(undefined));
    expect(releaseCount).toBe(1);
    expect(host.diagnostics().map((entry) => entry.status)).toEqual(['disposed', 'disposed']);
  });

  it('keeps the owning identity and order on prepared-state and record failures', () => {
    const resolver = createPreparedGraphicsResolver({
      device: {} as RhiDevice,
      featureIdentity: 'synthetic.m10.resolver',
      generation: 2,
      capabilityAvailable: true,
      featureOrder: 7,
      lookup: () => undefined,
      resolvePipeline: () => ok({} as never),
      resolveBindings: () => ok(undefined),
    });
    const missing = resolver.resolve({ kind: 'vertex-data', generation: 2 });
    expect(missing).toMatchObject({
      ok: false,
      error: {
        code: 'render-feature-prepared-state-mismatch',
        detail: { featureIdentity: 'synthetic.m10.resolver', order: 7 },
      },
    });

    const pipeline = { kind: 'pipeline' as const, generation: 0 };
    const bindings = { kind: 'bindings' as const, generation: 0 };
    const vertices = { kind: 'vertex-data' as const, generation: 0 };
    const recorded = recordResolvedRenderFeatureGraphicsPass(
      'synthetic.m10.record-order',
      {
        attachments: {
          colors: [
            { resource: 'swapchain', format: 'rgba8unorm', loadOp: 'load', storeOp: 'store' },
          ],
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
      },
      {
        capabilityAvailable: true,
        generation: 0,
        attachments: [{ resource: 'swapchain', format: 'rgba8unorm' }],
        pipeline,
        pipelines: [pipeline],
        bindings: [bindings],
        vertexData: [vertices],
        indexData: [],
      },
      { generation: 0, resolve: () => undefined },
      { pipeline: 0, binding: 0, vertex: 0, index: 0, draw: 0 },
      4,
    );
    expect(recorded).toMatchObject({
      ok: false,
      error: {
        code: 'render-feature-stage-failed',
        detail: { featureIdentity: 'synthetic.m10.record-order', order: 4, stage: 'record' },
      },
    });
  });
});

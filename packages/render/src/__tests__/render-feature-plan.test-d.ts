import type { TextureFormat } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import type { RenderFeaturePlan, RenderFeaturePlanContext } from '../features/plan';
import type { RenderFeature } from '../features/types';
import type { RenderFeatureRecovery } from '../features/vocabulary';

const format: TextureFormat = 'rgba8unorm';

const plan: RenderFeaturePlan = {
  resources: [
    {
      kind: 'compute-program',
      name: 'simulate-program',
      program: {
        wgsl: '@compute @workgroup_size(1) fn simulate() {}',
        entryPoints: ['simulate'],
        bindings: [
          {
            entries: [
              { binding: 0, visibility: 4, buffer: { type: 'storage' } },
              { binding: 1, visibility: 4, buffer: { type: 'uniform' } },
            ],
          },
        ],
      },
    },
    {
      kind: 'graphics-program',
      name: 'draw-program',
      program: {
        shader: 'forgeax::feature-draw',
        vertexLayout: 'position',
        colorFormats: [format],
      },
    },
    {
      kind: 'buffer',
      name: 'particles',
      size: 256,
      usage: ['storage', 'vertex'],
    },
    {
      kind: 'buffer',
      name: 'params',
      size: 16,
      usage: ['uniform'],
    },
    {
      kind: 'buffer',
      name: 'indirect-draw',
      size: 16,
      usage: ['storage', 'indirect'],
    },
    {
      kind: 'compute-bindings',
      name: 'simulate-bindings',
      program: 'simulate-program',
      entries: [
        { binding: 0, resource: 'particles' },
        { binding: 1, resource: 'params' },
      ],
    },
    {
      kind: 'graphics-bindings',
      name: 'draw-bindings',
      program: 'draw-program',
      values: { opacity: 1 },
    },
    {
      kind: 'vertex-data',
      name: 'particle-vertices',
      layout: 'position',
      buffer: 'particles',
    },
  ],
  passes: [
    {
      kind: 'compute',
      name: 'simulate',
      program: 'simulate-program',
      bindings: 'simulate-bindings',
      dispatches: [{ kind: 'direct', entryPoint: 'simulate', workgroups: [1, 1, 1] }],
    },
    {
      kind: 'raster',
      name: 'draw',
      colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
      draws: [
        {
          program: 'draw-program',
          bindings: ['draw-bindings'],
          vertexData: [{ slot: 0, resource: 'particle-vertices' }],
          draw: { kind: 'draw-indirect', resource: 'indirect-draw' },
        },
      ],
    },
  ],
};

const feature = {
  identity: 'synthetic.plan',
  extract: () => ok({ frame: 1 }),
  plan(data: { readonly frame: number }, context: RenderFeaturePlanContext) {
    void data;
    void context.frame;
    void context.caps;
    // @ts-expect-error plan callbacks cannot access a raw device.
    void context.device;
    // @ts-expect-error plan callbacks cannot access a queue.
    void context.queue;
    // @ts-expect-error plan callbacks cannot access an encoder.
    void context.encoder;
    // @ts-expect-error plan callbacks cannot submit work.
    void context.submit;
    return ok(plan);
  },
} satisfies RenderFeature<{ readonly frame: number }>;

const missingPlan = {
  identity: 'synthetic.invalid',
  extract: () => ok(undefined),
};
// @ts-expect-error RenderFeature plan is mandatory.
const invalidFeature: RenderFeature<undefined> = missingPlan;

const invalidDispatch: RenderFeaturePlan = {
  resources: [],
  passes: [
    {
      kind: 'compute',
      name: 'bad',
      program: 'missing',
      bindings: 'missing',
      dispatches: [
        {
          // @ts-expect-error dispatch variants are closed; callbacks are not executable descriptors.
          kind: 'callback',
          callback: () => undefined,
        },
      ],
    },
  ],
};

function recoveryLabel(recovery: RenderFeatureRecovery): string {
  switch (recovery) {
    case 'next-frame':
      return recovery;
    case 'renderer-recover':
      return recovery;
    case 'registration':
      return recovery;
  }
  const exhaustive: never = recovery;
  return exhaustive;
}

void feature;
void invalidFeature;
void invalidDispatch;
void recoveryLabel;

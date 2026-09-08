import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRenderFeatureHost, runRenderFeatureFrame } from '../features/host';
import {
  deriveRenderFeaturePassAccess,
  freezeRenderFeaturePlan,
  type RenderFeaturePlan,
  renderFeaturePlanSignature,
} from '../features/plan';
import type { RenderFeature } from '../features/types';

const plan = (data = new Uint32Array([1, 2, 3, 4])) =>
  ({
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
          colorFormats: ['rgba8unorm'],
        },
      },
      {
        kind: 'buffer',
        name: 'particles',
        size: 64,
        usage: ['storage', 'vertex'],
        data,
      },
      {
        kind: 'buffer',
        name: 'params',
        size: 16,
        usage: ['uniform'],
      },
      {
        kind: 'buffer',
        name: 'indirect',
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
        values: {},
      },
      {
        kind: 'vertex-data',
        name: 'vertices',
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
        dispatches: [{ kind: 'direct', entryPoint: 'simulate', workgroups: [1] }],
      },
      {
        kind: 'raster',
        name: 'draw',
        colorAttachments: [{ target: 'color', loadOp: 'load', storeOp: 'store' }],
        draws: [
          {
            program: 'draw-program',
            bindings: ['draw-bindings'],
            vertexData: [{ slot: 0, resource: 'vertices' }],
            draw: { kind: 'draw-indirect', resource: 'indirect' },
          },
        ],
      },
    ],
  }) satisfies RenderFeaturePlan;

describe('RenderFeature plan authority', () => {
  it('derives compute and raster access from descriptors', () => {
    const value = plan();
    expect(deriveRenderFeaturePassAccess(value, value.passes[0] as never)).toEqual([
      { resource: 'particles', usage: 'storage-read-write' },
      { resource: 'params', usage: 'uniform-read' },
    ]);
    expect(deriveRenderFeaturePassAccess(value, value.passes[1] as never)).toEqual([
      { resource: 'color', usage: 'color-attachment' },
      { resource: 'particles', usage: 'vertex-read' },
      { resource: 'indirect', usage: 'indirect-read' },
    ]);
  });

  it('keeps buffer uploads out of the stable topology signature', () => {
    expect(renderFeaturePlanSignature(plan(new Uint32Array([1])))).toBe(
      renderFeaturePlanSignature(plan(new Uint32Array([2]))),
    );
  });

  it('rejects descriptor references that do not exist', () => {
    const invalid: RenderFeaturePlan = {
      resources: [],
      passes: [
        {
          kind: 'compute',
          name: 'simulate',
          program: 'missing',
          bindings: 'missing',
          dispatches: [{ kind: 'direct', entryPoint: 'main', workgroups: [1] }],
        },
      ],
    };
    expect(freezeRenderFeaturePlan('synthetic.invalid', invalid).ok).toBe(false);
  });

  it('never invokes legacy producer callbacks', () => {
    const prepare = vi.fn();
    const contribute = vi.fn();
    const legacyShaped = {
      identity: 'synthetic.plan-only',
      extract: () => ok(undefined),
      plan: () => ok({ resources: [], passes: [] }),
      prepare,
      contribute,
    };
    const feature: RenderFeature<undefined> = legacyShaped;
    const host = createRenderFeatureHost([feature]);
    expect(host.ok).toBe(true);
    if (!host.ok) return;

    const result = runRenderFeatureFrame(host.value, {
      worlds: [],
      owner: 0,
      frameNumber: 1,
      caps: {} as never,
    });

    expect(result.errors).toEqual([]);
    expect(result.plans).toHaveLength(1);
    expect(result.plans[0]).not.toHaveProperty('execution');
    expect(result.stageEvents.map((event) => event.stage)).toEqual(['extract', 'plan']);
    expect(prepare).not.toHaveBeenCalled();
    expect(contribute).not.toHaveBeenCalled();
  });
});

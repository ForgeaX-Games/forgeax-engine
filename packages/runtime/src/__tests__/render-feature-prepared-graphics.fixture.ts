import { World } from '@forgeax/engine-ecs';
import type {
  Renderer,
  RenderFeature,
  RenderFeaturePlan,
  RenderFrameInput,
} from '@forgeax/engine-render';
import { Camera } from '@forgeax/engine-render';
import { Transform } from '@forgeax/engine-scene';
import { ok } from '@forgeax/engine-types';

export type PreparedFeatureMode = 'accepted' | 'empty' | 'mismatch' | 'recovery';

export const preparedManifest = `data:application/json,${encodeURIComponent(
  JSON.stringify({
    schemaVersion: '1.0.0',
    entries: [
      { hash: 'pbr00000', wgsl: '/* pbr stub */', glsl: '', bindings: '' },
      { hash: 'unlit000', wgsl: '/* unlit stub */', glsl: '', bindings: '' },
      { hash: 'tonemap0', wgsl: '/* tonemap stub */', glsl: '', bindings: '' },
    ],
  }),
)}`;

export function preparedFeature(
  identity: string,
  mode: PreparedFeatureMode = 'accepted',
): RenderFeature<{ readonly draw: boolean }> {
  let firstPlan = true;

  return {
    identity,
    extract: () => ok({ draw: mode !== 'empty' }),
    plan: (data, context) => {
      if (!data.draw) return ok({ resources: [], passes: [] });
      const target = context.targets.find((candidate) => candidate.kind === 'color');
      const targetName = target?.name ?? 'swapchain';
      const mismatch = mode === 'mismatch' || (mode === 'recovery' && firstPlan);
      firstPlan = false;
      const plan: RenderFeaturePlan = {
        resources: [
          {
            kind: 'graphics-program',
            name: 'forward-program',
            program: {
              shader: 'forgeax::tonemap',
              vertexLayout: 'position',
              colorFormats: [target?.format ?? 'rgba16float'],
            },
          },
          {
            kind: 'graphics-bindings',
            name: 'forward-bindings',
            program: 'forward-program',
            values: {},
          },
          {
            kind: 'graphics-bindings',
            name: 'input-bindings',
            program: 'forward-program',
            values: { group: 1 },
          },
          {
            kind: 'vertex-data',
            name: 'triangle-vertices',
            layout: 'position',
            data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
          },
        ],
        passes: [
          {
            kind: 'raster',
            name: 'forward',
            colorAttachments: [{ target: targetName, loadOp: 'load', storeOp: 'store' }],
            draws: [
              {
                program: mismatch ? 'forged-program' : 'forward-program',
                bindings: ['forward-bindings', 'input-bindings'],
                vertexData: [{ slot: 0, resource: 'triangle-vertices' }],
                draw: { kind: 'draw', vertexCount: 3, instanceCount: 1 },
              },
            ],
          },
        ],
      };
      return ok(plan);
    },
  };
}

export function preparedWorld(): World {
  const world = new World();
  world.spawn(
    { component: Transform, data: { pos: [0, 0, 3], quat: [0, 0, 0, 1], scale: [1, 1, 1] } },
    { component: Camera, data: { fov: 60, aspect: 1, near: 0.1, far: 100 } },
  );
  return world;
}

export function frameRequest(
  lease: Parameters<Renderer['draw']>[0]['leases'][number],
): RenderFrameInput {
  return { leases: [lease], camera: { lease }, environment: { lease } };
}

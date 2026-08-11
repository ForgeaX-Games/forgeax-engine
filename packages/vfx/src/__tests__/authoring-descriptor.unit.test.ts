import { describe, expect, it } from 'vitest';
import { describeVfxGpuEffect, isVfxGpuEffectAsset } from '../authoring-descriptor.js';
import type { VfxGpuEffectAsset } from '../gpu-program.js';

const effect: VfxGpuEffectAsset = {
  guid: 'effect-guid',
  kind: 'particle-effect',
  schemaVersion: 2,
  programFingerprint: 'sha256:effect',
  emitters: [{ id: 'sparks', capacity: 128 }],
  program: {
    format: 'forgeax-vfx-program-2',
    fingerprint: 'sha256:effect',
    emitters: [
      {
        id: 'sparks',
        module: 'sparks.vfx.wgsl',
        capacity: 128,
        backend: { required: 'gpu' },
        space: 'world',
        schedule: { rate: 8, bursts: [{ time: 0, count: 4 }], loopDuration: 2 },
        bounds: { kind: 'sphere', center: [0, 1, 0], radius: 4 },
        renderers: [
          { kind: 'billboard', material: 'material-guid', sorting: 'back-to-front' },
          { kind: 'beam', material: 'beam-material-guid', endpointField: 'velocity', capacity: 32 },
        ],
        channels: [{ id: 'impact', payload: 'impact', capacity: 8, overflow: 'drop-newest' }],
        events: [
          {
            id: 'impact-event',
            channel: 'impact',
            subEmitter: 'sparks',
            fanOut: 1,
            recursionDepth: 1,
          },
        ],
        simulationWhenCulled: 'continue',
        wgsl: 'cooked',
        reflection: {
          hooks: ['vfx_spawn', 'vfx_update'],
          imports: ['game::noise'],
          resources: ['particles'],
          entryPoints: ['forgeax_vfx_spawn_main'],
          bindings: [],
          layout: {
            version: 1,
            parameters: {
              name: 'VfxParameters',
              fields: [
                {
                  name: 'strength',
                  type: 'f32',
                  offset: 0,
                  size: 4,
                  alignment: 4,
                  defaultValue: 1,
                },
              ],
              size: 16,
              alignment: 16,
            },
            custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
            fingerprint: 'sha256:layout',
          },
          stages: [
            {
              id: 'turbulence',
              entry: 'vfx_turbulence',
              entryPoint: 'forgeax_vfx_stage_turbulence',
              domain: 'particle',
              resources: [{ name: 'particles', access: 'read-write' }],
              dependsOn: [],
              iterationBudget: 2,
            },
          ],
        },
      },
    ],
  },
};

describe('VFX authoring descriptor', () => {
  it('owns the cooked asset type guard at the producer boundary', () => {
    expect(isVfxGpuEffectAsset(effect)).toBe(true);
    expect(
      isVfxGpuEffectAsset({ ...effect, program: { ...effect.program, format: 'legacy' } }),
    ).toBe(false);
    expect(isVfxGpuEffectAsset({ kind: 'particle-effect', schemaVersion: 2 })).toBe(false);
  });
  it('projects one producer-owned system tree, timeline, dependencies, and capability truth', () => {
    const descriptor = describeVfxGpuEffect(effect);

    expect(descriptor).toMatchObject({
      version: 1,
      assetGuid: 'effect-guid',
      artifactFingerprint: 'sha256:effect',
      timeline: [{ emitterId: 'sparks', rate: 8, loopDuration: 2 }],
    });
    expect(descriptor.emitters[0]).toMatchObject({
      id: 'emitter:sparks',
      role: 'emitter',
      label: 'sparks',
      module: 'sparks.vfx.wgsl',
    });
    expect(descriptor.emitters[0]?.children.map((node) => node.role)).toEqual([
      'program',
      'parameters',
      'stage',
      'channel',
      'event',
      'renderer',
      'renderer',
    ]);
    expect(descriptor.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'module', identity: 'sparks.vfx.wgsl' }),
        expect.objectContaining({ kind: 'asset', identity: 'material-guid' }),
        expect.objectContaining({ kind: 'asset', identity: 'beam-material-guid' }),
        expect.objectContaining({ kind: 'module', identity: 'game::noise' }),
      ]),
    );
    expect(descriptor.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'runtime-parameters', state: 'partial' }),
        expect.objectContaining({ id: 'deterministic-replay', state: 'executable' }),
      ]),
    );
    expect(JSON.stringify(descriptor)).not.toContain('wgsl":"cooked');
  });
});

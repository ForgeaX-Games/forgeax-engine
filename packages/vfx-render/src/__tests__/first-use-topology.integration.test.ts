import { World } from '@forgeax/engine-ecs';
import type { MeshAsset } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { gpuParticleRenderFeature, planPasses, planResources } from './vfx-frame-fixture';

const identity = () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const kinds = ['billboard', 'mesh', 'ribbon', 'trail', 'beam'] as const;
const simulation = [
  'spawn',
  'update',
  'scan_blocks',
  'scan_block_offsets',
  'add_offsets',
  'compact',
  'event',
  'stage_swirl',
];
const entries = [
  ...simulation,
  'sort',
  ...kinds,
  'trail_history',
  'trail_offsets',
  'future_kernel',
].map((name) => `forgeax_vfx_${name}_main`);
const mesh: MeshAsset = {
  kind: 'mesh',
  vertices: new Float32Array(18),
  attributes: {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal: new Float32Array(9),
    uv: new Float32Array(6),
  },
  indices: new Uint16Array([0, 1, 2]),
  submeshes: [
    { indexOffset: 0, indexCount: 3, vertexCount: 3, topology: 'triangle-list', materialSlot: 0 },
  ],
  materialSlots: [{ slotName: 'Default' }],
};

for (let mask = 0; mask < 32; mask += 1) {
  const selected = kinds.filter((_, index) => (mask & (1 << index)) !== 0);
  it(`prepares only authored VFX topologies: ${selected.join('+') || 'simulation-only'}`, () => {
    const world = new World();
    const player = world.spawn().unwrap();
    const camera = {
      position: new Float32Array(3),
      right: new Float32Array([1, 0, 0]),
      up: new Float32Array([0, 1, 0]),
      viewProjection: identity(),
    };
    const renderers = selected.map((kind) => ({
      kind,
      material: 'material',
      mesh: 'mesh',
      capacity: 4,
      historyLength: 4,
      stripKey: 'alive-index',
      endpointField: 'velocity',
      sorting: 'view-depth',
      enabled: true,
      castShadows: kind === 'mesh',
    }));
    const emitter = {
      id: 'first-use',
      capacity: 4,
      space: 'world',
      simulationWhenCulled: 'continue',
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 0.1 },
      wgsl: '// unchanged cooked source',
      schedule: { rate: 0, bursts: [{ time: 0, count: 1 }] },
      reflection: {
        entryPoints: entries,
        bindings: [],
        dataInterfaces: [],
        stages: [
          {
            id: 'swirl',
            entry: 'swirl',
            entryPoint: 'forgeax_vfx_stage_swirl_main',
            domain: 'particle',
            resources: [],
            dependsOn: ['update'],
            iterationBudget: 1,
          },
        ],
      },
      renderers,
    };
    const intent = {
      sequence: 1,
      player,
      emitter,
      programFingerprint: 'fixture',
      reset: true,
      fixedDelta: 1 / 60,
      phaseTick: 0,
      tick: 0,
      seed: 1,
      playCycle: 0,
      spawnCount: 1,
      firstParticleId: 0,
      instanceGeneration: 0,
      channelInputs: [],
      eventCounters: {},
      parameterBlock: new Uint8Array(),
    };
    const entry = {
      worldId: 0,
      runtimeId: 0,
      renderGeneration: 0,
      camera,
      views: [{ identity: 'main', camera }],
      intents: [intent],
      retained: [] as unknown[],
      materials: new Map(),
      meshes: new Map([['mesh', mesh]]),
      emitterState: new Map([
        [
          `${Number(player)}:first-use`,
          { enabled: true, localToWorld: identity(), player, emitter },
        ],
      ]),
    };
    const feature = gpuParticleRenderFeature({ camera: { read: () => camera } });
    let frameNumber = 0;
    const plan = () =>
      feature
        .plan(
          { worlds: [entry], frameNumber: ++frameNumber } as never,
          { targets: [], caps: {}, generation: 1 } as never,
        )
        .unwrap();
    let firstRasterPassCount: number | undefined;
    const program = () => {
      const planned = plan();
      firstRasterPassCount ??= planPasses(planned).filter((pass) => pass.kind === 'raster').length;
      const row = planResources(planned).find((resource) => resource.kind === 'compute-program');
      if (row?.kind !== 'compute-program') throw new Error('missing native compute program');
      for (const pass of planPasses(planned)) {
        if (pass.kind !== 'compute' || pass.program !== row.name) continue;
        for (const dispatch of pass.dispatches)
          expect(row.program.entryPoints).toContain(dispatch.entryPoint);
      }
      return row.program;
    };
    const first = program();
    expect(firstRasterPassCount).toBe(selected.length);
    expect(first.wgsl).toBe(emitter.wgsl);
    expect(first.bindings).toEqual(emitter.reflection.bindings);
    for (const kind of kinds) {
      if (!selected.includes(kind))
        expect(first.entryPoints).not.toContain(`forgeax_vfx_${kind}_main`);
    }
    for (const name of [...simulation, 'future_kernel'])
      expect(first.entryPoints).toContain(`forgeax_vfx_${name}_main`);
    intent.reset = false;
    camera.viewProjection[12] = 10_000;
    expect(program()).toEqual(first);
    camera.viewProjection[12] = 0;
    expect(program()).toEqual(first);
    for (const renderer of renderers) renderer.enabled = false;
    expect(program()).toEqual(first);
    for (const renderer of renderers) {
      renderer.enabled = true;
      renderer.sorting = 'custom-descending';
    }
    expect(program()).toEqual(first);
    entry.intents = [];
    entry.retained = [{ player, emitter, intent, localToWorld: identity(), visible: true }];
    expect(program()).toEqual(first);
    entry.retained = [];
    intent.reset = true;
    intent.playCycle += 1;
    intent.sequence += 1;
    entry.intents = [intent];
    expect(program()).toEqual(first);
  });
}

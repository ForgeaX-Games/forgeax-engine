import { World } from '@forgeax/engine-ecs';
import { runPlugins } from '@forgeax/engine-plugin';
import type { LoadContext } from '@forgeax/engine-types';
import {
  createStockParticleCpuExecutorRegistry,
  PARTICLE_SIMULATION_RESOURCE_KEY,
  ParticleEffectPlayer,
  type ParticleEffectPlayerData,
  type ParticleEffectSource,
  type ParticleSimulation,
  particleEffectPackLoader,
  particleSimulationPlugin,
} from '@forgeax/engine-vfx';
import {
  cookParticleEffect,
  createStockParticleOperatorRegistry,
} from '@forgeax/engine-vfx-compiler';
import { describe, expect, it } from 'vitest';

type ParticleCookProduct = Extract<
  ReturnType<typeof cookParticleEffect>,
  { readonly ok: true }
>['value'];

const source: ParticleEffectSource = {
  schemaVersion: 1,
  emitters: [
    {
      id: 'stock-spark',
      capacity: 16,
      space: 'world',
      schedule: { rate: 8, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      operators: {
        spawn: [{ kind: 'shape', version: 1, params: { shape: 'sphere', radius: 1 } }],
        initialize: [
          { kind: 'lifetime', version: 1, params: { seconds: 1 } },
          { kind: 'initial-velocity', version: 1, params: { velocity: [0, 2, 0] } },
        ],
        update: [
          { kind: 'gravity', version: 1, params: { acceleration: [0, -9.8, 0] } },
          { kind: 'drag', version: 1, params: { coefficient: 0.2 } },
          {
            kind: 'size-over-life',
            version: 1,
            params: {
              curve: {
                points: [
                  { time: 0, value: 1 },
                  { time: 1, value: 0 },
                ],
              },
            },
          },
          {
            kind: 'color-over-life',
            version: 1,
            params: {
              gradient: {
                stops: [
                  { time: 0, color: [1, 1, 1, 1] },
                  { time: 1, color: [1, 0, 0, 0] },
                ],
              },
            },
          },
        ],
        output: [{ kind: 'billboard', version: 1, params: {} }],
      },
      output: { kind: 'billboard', material: 'material-stock' },
    },
  ],
};

function loadContext(): LoadContext {
  return {
    fetchBinary: async () => ({ ok: true, value: new Uint8Array() }),
    resolveRef: async () => ({ ok: true, value: 0 }),
    transcodeCaps: { bc: false, etc2: false, astc: false },
    device: undefined,
  };
}

function assertCookedPair(cooked: ParticleCookProduct): void {
  expect(cooked.asset.emitters).toEqual([
    { id: 'stock-spark', capacity: 16 },
    { id: 'stock-mesh', capacity: 16 },
  ]);
  expect(cooked.refs).toEqual([{ guid: 'material-stock' }, { guid: 'mesh-stock' }]);
  expect(cooked.program.payload.emitters.map((emitter) => emitter.output.kind)).toEqual([
    'billboard',
    'mesh',
  ]);
}

async function simulateCookedPair(cooked: ParticleCookProduct): Promise<void> {
  const loaded = await particleEffectPackLoader.load(
    {
      guid: 'stock-effect',
      kind: 'particle-effect',
      payload: cooked.asset as unknown as Record<string, unknown>,
      refs: cooked.refs.map((ref) => ref.guid),
      artifacts: {
        'particle-effect/program.json': {
          descriptor: { path: 'program.json', mediaType: 'application/json' },
          bytes: cooked.program.bytes,
        },
      },
    },
    loadContext(),
  );
  expect(loaded.ok).toBe(true);
  if (!loaded.ok) return;
  const loadedMeshColor = loaded.value.program.emitters[1]?.programs.cpu?.find(
    (entry) => entry.operator === 'update:color-over-life:1',
  );
  expect(loadedMeshColor?.program).toEqual({
    gradient: {
      stops: [
        { time: 0, color: [0.2, 0.75, 1, 1] },
        { time: 1, color: [0.05, 0.3, 1, 0] },
      ],
    },
  });

  const world = new World({ time: { fixedDeltaSeconds: 0.1, maxDeltaSeconds: 0.5 } });
  const effect = world.allocSharedRef('ParticleEffectAsset', loaded.value);
  const spawned = world.spawn({
    component: ParticleEffectPlayer,
    data: {
      effect,
      playing: true,
      seed: 11,
      timeScale: 1,
    } satisfies ParticleEffectPlayerData,
  });
  expect(spawned.ok).toBe(true);
  if (!spawned.ok) return;

  const assets = new Map<string, unknown>([
    ['material-stock', { kind: 'material' }],
    ['mesh-stock', { kind: 'mesh' }],
  ]);
  const plugins = await runPlugins(
    world,
    [],
    [
      particleSimulationPlugin({
        assets: { lookup: (guid) => assets.get(guid) },
        cpuExecutors: createStockParticleCpuExecutorRegistry(),
      }),
    ],
  );
  expect(plugins.ok).toBe(true);
  if (!plugins.ok) return;
  const update = world.update(0.1);
  expect(update.ok).toBe(true);
  if (!update.ok) return;

  const simulation = world.getResource<ParticleSimulation>(PARTICLE_SIMULATION_RESOURCE_KEY);
  const observation = simulation.read(spawned.value);
  expect(observation?.emitters).toEqual([
    {
      emitterId: 'stock-spark',
      status: 'ready',
      liveCount: 1,
      capacity: 16,
      overflowCount: 0,
      spawned: 1,
      dropped: 0,
    },
    {
      emitterId: 'stock-mesh',
      status: 'ready',
      liveCount: 1,
      capacity: 16,
      overflowCount: 0,
      spawned: 1,
      dropped: 0,
    },
  ]);
  expect(observation?.batches.batches.map((batch) => batch.kind)).toEqual(['billboard', 'mesh']);
  const meshBatch = observation?.batches.batches.find((batch) => batch.kind === 'mesh');
  const meshColor = meshBatch?.attributes.color ?? new Float32Array();
  expect(meshColor[0]).toBeCloseTo(0.2, 5);
  expect(meshColor[1]).toBeCloseTo(0.75, 5);
  expect(meshColor[2]).toBeCloseTo(1, 5);
  expect(meshColor[3]).toBeCloseTo(1, 5);
}

describe('stock particle cook', () => {
  it('produces stable asset, program bytes, and digest for repeated cooks', () => {
    const registry = createStockParticleOperatorRegistry();
    const first = cookParticleEffect(source, registry);
    const second = cookParticleEffect(structuredClone(source), registry);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.asset).toEqual(second.value.asset);
    expect([...first.value.program.bytes]).toEqual([...second.value.program.bytes]);
    expect(first.value.program.fingerprint).toBe(second.value.program.fingerprint);
    expect(first.value.outputDigest).toBe(second.value.outputDigest);
  });

  it('cooks billboard and mesh emitters through the default stock factory', async () => {
    const firstEmitter = source.emitters[0];
    if (firstEmitter === undefined) throw new Error('expected the stock fixture emitter');
    const secondEmitter = {
      ...firstEmitter,
      id: 'stock-mesh',
      schedule: { rate: 10, bursts: [] },
      operators: {
        ...firstEmitter.operators,
        update: firstEmitter.operators.update.map((operator) =>
          operator.kind === 'color-over-life'
            ? {
                ...operator,
                params: {
                  gradient: {
                    stops: [
                      { time: 0, color: [0.2, 0.75, 1, 1] },
                      { time: 1, color: [0.05, 0.3, 1, 0] },
                    ],
                  },
                },
              }
            : operator,
        ),
      },
      output: { kind: 'mesh' as const, material: 'material-stock', mesh: 'mesh-stock' },
    };
    const pairedSource: ParticleEffectSource = {
      ...source,
      emitters: [{ ...firstEmitter, schedule: { rate: 10, bursts: [] } }, secondEmitter],
    };
    const cooked = cookParticleEffect(
      JSON.parse(JSON.stringify(pairedSource)),
      createStockParticleOperatorRegistry(),
    );

    expect(cooked.ok).toBe(true);
    if (!cooked.ok) return;
    assertCookedPair(cooked.value);
    const firstColor = cooked.value.program.payload.emitters[0]?.programs.cpu?.find(
      (entry) => entry.operator === 'update:color-over-life:1',
    );
    const secondColor = cooked.value.program.payload.emitters[1]?.programs.cpu?.find(
      (entry) => entry.operator === 'update:color-over-life:1',
    );
    expect(firstColor?.program).toEqual({
      gradient: {
        stops: [
          { time: 0, color: [1, 1, 1, 1] },
          { time: 1, color: [1, 0, 0, 0] },
        ],
      },
    });
    expect(secondColor?.program).toEqual({
      gradient: {
        stops: [
          { time: 0, color: [0.2, 0.75, 1, 1] },
          { time: 1, color: [0.05, 0.3, 1, 0] },
        ],
      },
    });
    await simulateCookedPair(cooked.value);
  });
});

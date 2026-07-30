import type { LoadContext, ParticleEffectAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { particleEffectPackLoader } from '../index.js';

const EFFECT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
const PROGRAM_ARTIFACT = 'particle-effect/program.json';

const payload: ParticleEffectAsset = {
  kind: 'particle-effect',
  schemaVersion: 1,
  emitters: [
    { id: 'spark', capacity: 32 },
    { id: 'smoke', capacity: 8 },
  ],
};

const canonicalProgram = {
  format: 'forgeax-vfx-program-1',
  emitters: [
    {
      id: 'spark',
      capacity: 32,
      space: 'world',
      schedule: { rate: 12, bursts: [{ time: 0.5, count: 3 }] },
      bounds: { min: [-1, -2, -3], max: [1, 2, 3] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      backendPlan: { kind: 'cpu', backends: ['cpu'] },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: { rate: 12 } }],
        initialize: [{ kind: 'set-life', version: 1, params: { seconds: 1 } }],
        update: [{ kind: 'gravity', version: 1, params: { y: -9.8 } }],
        output: [{ kind: 'billboard', version: 1, params: { size: 0.25 } }],
      },
      output: { kind: 'billboard', material: 'material-spark' },
      programs: {
        cpu: [
          { operator: 'spawn:spawn-rate:1', program: { opcode: 'spawn-rate', rate: 12 } },
          { operator: 'initialize:set-life:1', program: { opcode: 'set-life', seconds: 1 } },
          { operator: 'update:gravity:1', program: { opcode: 'gravity', y: -9.8 } },
          { operator: 'output:billboard:1', program: { opcode: 'billboard', size: 0.25 } },
        ],
      },
    },
    {
      id: 'smoke',
      capacity: 8,
      space: 'local',
      schedule: { rate: 2, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'preferred', backend: 'gpu', fallback: 'cpu' },
      backendPlan: { kind: 'gpu-with-cpu-fallback', backends: ['gpu', 'cpu'] },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: { rate: 2 } }],
        initialize: [{ kind: 'set-life', version: 1, params: { seconds: 2 } }],
        update: [{ kind: 'drag', version: 1, params: { factor: 0.2 } }],
        output: [{ kind: 'mesh', version: 1, params: { mesh: 'mesh-smoke' } }],
      },
      output: { kind: 'mesh', material: 'material-smoke', mesh: 'mesh-smoke' },
      programs: {
        gpu: [
          { operator: 'spawn:spawn-rate:1', program: { opcode: 'spawn-rate', rate: 2 } },
          { operator: 'initialize:set-life:1', program: { opcode: 'set-life', seconds: 2 } },
          { operator: 'update:drag:1', program: { opcode: 'drag', factor: 0.2 } },
          { operator: 'output:mesh:1', program: { opcode: 'mesh', mesh: 'mesh-smoke' } },
        ],
        cpu: [
          { operator: 'spawn:spawn-rate:1', program: { opcode: 'spawn-rate', rate: 2 } },
          { operator: 'initialize:set-life:1', program: { opcode: 'set-life', seconds: 2 } },
          { operator: 'update:drag:1', program: { opcode: 'drag', factor: 0.2 } },
          { operator: 'output:mesh:1', program: { opcode: 'mesh', mesh: 'mesh-smoke' } },
        ],
      },
    },
  ],
};

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function input(program: unknown = canonicalProgram) {
  return {
    guid: EFFECT_GUID,
    kind: 'particle-effect',
    payload: payload as unknown as Record<string, unknown>,
    refs: [],
    artifacts: {
      [PROGRAM_ARTIFACT]: {
        descriptor: { path: PROGRAM_ARTIFACT, mediaType: 'application/json' },
        bytes: bytes(program),
      },
    },
  };
}

function context(): LoadContext {
  return {
    fetchBinary: async () => ({ ok: true, value: new Uint8Array() }),
    resolveRef: async () => ({ ok: true, value: 1 }),
    transcodeCaps: { bc: false, etc2: false, astc: false },
    device: undefined,
  };
}

function mutateProgram(mutator: (program: Record<string, unknown>) => void): unknown {
  const copy = structuredClone(canonicalProgram) as Record<string, unknown>;
  mutator(copy);
  return copy;
}

describe('runtime particle program projection', () => {
  it('projects the complete asset-local canonical program without creating live state', async () => {
    const result = await particleEffectPackLoader.load(input(), context());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const loaded = result.value as typeof result.value & {
      readonly program: typeof canonicalProgram;
    };

    expect(loaded.program).toEqual(canonicalProgram);
    expect(Object.isFrozen(loaded.program)).toBe(true);
    expect(Object.isFrozen(loaded.program.emitters[0])).toBe(true);
    expect(loaded.program.emitters.map((emitter) => emitter.id)).toEqual(['spark', 'smoke']);
    expect(loaded.program.emitters[0]?.schedule).toEqual(canonicalProgram.emitters[0]?.schedule);
    expect(loaded.program.emitters[1]?.backendPlan).toEqual(
      canonicalProgram.emitters[1]?.backendPlan,
    );
    expect(loaded.program.emitters[0]?.programs.cpu).toHaveLength(4);
    expect(loaded.program.emitters[1]?.output).toEqual(canonicalProgram.emitters[1]?.output);
  });

  it.each([
    ['format', mutateProgram((program) => (program.format = 'other-format'))],
    [
      'emitter identity',
      mutateProgram((program) => {
        const emitters = program.emitters as Array<Record<string, unknown>>;
        const first = emitters[0];
        if (first !== undefined) first.id = 'wrong-id';
      }),
    ],
    [
      'emitter capacity',
      mutateProgram((program) => {
        const emitters = program.emitters as Array<Record<string, unknown>>;
        const first = emitters[0];
        if (first !== undefined) first.capacity = 64;
      }),
    ],
    [
      'schedule',
      mutateProgram((program) => {
        const emitters = program.emitters as Array<Record<string, unknown>>;
        const first = emitters[0];
        if (first !== undefined) first.schedule = { rate: -1, bursts: [] };
      }),
    ],
    [
      'backend plan',
      mutateProgram((program) => {
        const emitters = program.emitters as Array<Record<string, unknown>>;
        const second = emitters[1];
        if (second !== undefined) second.backendPlan = { kind: 'cpu', backends: ['cpu'] };
      }),
    ],
    [
      'ordered program',
      mutateProgram((program) => {
        const emitters = program.emitters as Array<Record<string, unknown>>;
        const first = emitters[0];
        if (first !== undefined) {
          const programs = first.programs as Record<string, unknown[]>;
          programs.cpu = [...(programs.cpu ?? [])].reverse();
        }
      }),
    ],
    [
      'output reference',
      mutateProgram((program) => {
        const emitters = program.emitters as Array<Record<string, unknown>>;
        const first = emitters[0];
        if (first !== undefined) first.output = { kind: 'billboard', material: '' };
      }),
    ],
  ])('rejects nested %s tampering before any live state exists', async (_label, program) => {
    const result = await particleEffectPackLoader.load(input(program), context());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(['vfx-asset-load-failed', 'vfx-program-invalid']).toContain(result.error.code);
      expect(result.error.detail).toBeDefined();
    }
  });
});

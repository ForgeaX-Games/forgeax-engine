import { describe, expect, it } from 'vitest';
import type { ParticleRuntimeProgram } from '../../runtime-program.js';
import {
  type ParticleCpuExecutorDefinition,
  ParticleCpuExecutorRegistry,
} from '../cpu-executor-registry.js';

const program: ParticleRuntimeProgram = {
  format: 'forgeax-vfx-program-1',
  emitters: [
    {
      id: 'spark',
      capacity: 4,
      space: 'world',
      schedule: { rate: 4, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      backendPlan: { kind: 'cpu', backends: ['cpu'] },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: { rate: 4 } }],
        initialize: [{ kind: 'set-life', version: 1, params: { seconds: 1 } }],
        update: [{ kind: 'gravity', version: 1, params: { y: -9.8 } }],
        output: [{ kind: 'billboard', version: 1, params: { size: 0.25 } }],
      },
      output: { kind: 'billboard', material: 'material-spark' },
      programs: {
        cpu: [
          { operator: 'spawn:spawn-rate:1', program: { rate: 4 } },
          { operator: 'initialize:set-life:1', program: { seconds: 1 } },
          { operator: 'update:gravity:1', program: { y: -9.8 } },
          { operator: 'output:billboard:1', program: { size: 0.25 } },
        ],
      },
    },
  ],
};

function definition(
  stage: 'spawn' | 'initialize' | 'update' | 'output',
  kind: string,
  version = 1,
): ParticleCpuExecutorDefinition {
  return {
    stage,
    kind,
    version,
    validateProgram: (value) =>
      typeof value === 'object' && value !== null
        ? { ok: true, value: undefined }
        : {
            ok: false,
            error: 'program must be an object',
          },
    execute: (context) => {
      expect(context.stage).toBe(stage);
      expect(context.operator).toBe(`${stage}:${kind}:${version}`);
      return { ok: true, value: undefined };
    },
  };
}

describe('CPU executor registry', () => {
  it('resolves every current CPU plan through stage-kind-version definitions', () => {
    const registry = new ParticleCpuExecutorRegistry([
      definition('spawn', 'spawn-rate'),
      definition('initialize', 'set-life'),
      definition('update', 'gravity'),
      definition('output', 'billboard'),
    ]);

    const result = registry.checkProgram(program, 'spark');

    expect(result.ok).toBe(true);
    expect(registry.list().map((item) => item.key)).toEqual([
      'initialize:set-life:1',
      'output:billboard:1',
      'spawn:spawn-rate:1',
      'update:gravity:1',
    ]);
  });

  it('exposes a missing executor when a new canonical plan key appears', () => {
    const registry = new ParticleCpuExecutorRegistry([
      definition('spawn', 'spawn-rate'),
      definition('initialize', 'set-life'),
      definition('update', 'gravity'),
      definition('output', 'billboard'),
    ]);
    const changed = structuredClone(program) as ParticleRuntimeProgram;
    const emitter = changed.emitters[0];
    if (emitter === undefined) throw new Error('fixture emitter missing');
    const changedEmitter = {
      ...emitter,
      programs: {
        ...emitter.programs,
        cpu: [
          ...(emitter.programs.cpu ?? []),
          { operator: 'update:wind:2', program: { strength: 3 } },
        ],
      },
    };
    const changedProgram = { ...changed, emitters: [changedEmitter] };

    const result = registry.checkProgram(changedProgram, 'spark');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail.operator).toBe('update:wind:2');
      expect(result.error.detail.stage).toBe('update');
    }
  });

  it('rejects malformed stage keys and invalid definition programs', () => {
    const registry = new ParticleCpuExecutorRegistry([
      definition('spawn', 'spawn-rate'),
      definition('initialize', 'set-life'),
      definition('update', 'gravity'),
      definition('output', 'billboard'),
    ]);
    const malformed = structuredClone(program) as ParticleRuntimeProgram;
    const emitter = malformed.emitters[0];
    if (emitter === undefined) throw new Error('fixture emitter missing');
    const malformedProgram = {
      ...malformed,
      emitters: [
        {
          ...emitter,
          programs: {
            ...emitter.programs,
            cpu: [{ operator: 'update:gravity:not-a-version', program: { y: -9.8 } }],
          },
        },
      ],
    };

    const malformedResult = registry.checkProgram(malformedProgram, 'spark');
    expect(malformedResult.ok).toBe(false);
    if (!malformedResult.ok) expect(malformedResult.error.detail.stage).toBe('update');

    const invalid = new ParticleCpuExecutorRegistry([
      {
        ...definition('spawn', 'spawn-rate'),
        validateProgram: () => ({ ok: false, error: 'rate is required' }),
      },
      definition('initialize', 'set-life'),
      definition('update', 'gravity'),
      definition('output', 'billboard'),
    ]);
    const invalidResult = invalid.checkProgram(program, 'spark');
    expect(invalidResult.ok).toBe(false);
    if (!invalidResult.ok) {
      expect(invalidResult.error.detail.operator).toBe('spawn:spawn-rate:1');
      expect(invalidResult.error.detail.reason).toBe('rate is required');
    }
  });
});

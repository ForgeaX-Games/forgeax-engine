import { ok, type Result } from '@forgeax/engine-types';
import type { ParticleBackendPolicy, ParticleEffectSource } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import {
  cookParticleEffect,
  type ParticleOperatorDefinition,
  ParticleOperatorRegistry,
} from '../index.js';

const kinds = ['spawn-rate', 'set-life', 'drag', 'billboard'] as const;
const stages = ['spawn', 'initialize', 'update', 'output'] as const;

function source(policy: ParticleBackendPolicy): ParticleEffectSource {
  return {
    schemaVersion: 1,
    emitters: [
      {
        id: 'matrix',
        capacity: 8,
        space: 'world',
        schedule: { rate: 1, bursts: [] },
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
        backendPolicy: policy,
        operators: {
          spawn: [{ kind: 'spawn-rate', version: 1, params: {} }],
          initialize: [{ kind: 'set-life', version: 1, params: {} }],
          update: [{ kind: 'drag', version: 1, params: {} }],
          output: [{ kind: 'billboard', version: 1, params: {} }],
        },
        output: { kind: 'billboard', material: 'fx/matrix' },
      },
    ],
  };
}

function definition(
  stage: (typeof stages)[number],
  kind: (typeof kinds)[number],
  backends: readonly ('cpu' | 'gpu')[],
): ParticleOperatorDefinition {
  return {
    stage,
    kind,
    version: 1,
    parameterSchema: {},
    validateParams: (): Result<void, never> => ok(undefined),
    compile: {
      ...(backends.includes('cpu') ? { cpu: () => ({ kind, backend: 'cpu' }) } : {}),
      ...(backends.includes('gpu') ? { gpu: () => ({ kind, backend: 'gpu' }) } : {}),
    },
  };
}

function registry(backends: readonly ('cpu' | 'gpu')[] = ['cpu', 'gpu']): ParticleOperatorRegistry {
  const result = new ParticleOperatorRegistry();
  for (const [index, kind] of kinds.entries()) {
    const registered = result.register(definition(stages[index] ?? 'spawn', kind, backends));
    if (!registered.ok) throw new Error(registered.error.code);
  }
  return result;
}

function cook(policy: ParticleBackendPolicy, backends?: readonly ('cpu' | 'gpu')[]) {
  return cookParticleEffect(source(policy), registry(backends));
}

describe('cook backend policy matrix', () => {
  it.each([
    [{ kind: 'required', backend: 'cpu' }, 'cpu', ['cpu']],
    [{ kind: 'required', backend: 'gpu' }, 'gpu', ['gpu']],
    [
      { kind: 'preferred', backend: 'gpu', fallback: 'cpu' },
      'gpu-with-cpu-fallback',
      ['gpu', 'cpu'],
    ],
    [{ kind: 'preferred', backend: 'gpu', fallback: 'disable' }, 'gpu-or-disable', ['gpu']],
  ] as const)('keeps %j policy honest', (policy, kind, backends) => {
    const result = cook(policy);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.backendPlans[0]).toEqual({ kind, backends });
      expect(result.value.program.payload.emitters[0]?.backendPlan).toEqual({ kind, backends });
    }
  });

  it('reports the missing required compiler instead of making a placeholder program', () => {
    const result = cook({ kind: 'required', backend: 'gpu' }, ['cpu']);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('vfx-operator-backend-unsupported');
      expect(result.error).toMatchObject({
        detail: { backend: 'gpu', emitterId: 'matrix' },
      });
    }
  });

  it('does not rewrite preferred GPU policy from runtime capability', () => {
    const result = cook({ kind: 'preferred', backend: 'gpu', fallback: 'cpu' }, ['cpu', 'gpu']);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.backendPlans[0]?.backends).toEqual(['gpu', 'cpu']);
    }
  });
});

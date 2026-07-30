import { ok, type Result } from '@forgeax/engine-types';
import {
  defineParticleEffectSource,
  type ParticleEffectSource,
  type ParticleOperatorStage,
} from '@forgeax/engine-vfx';
import {
  cookParticleEffect,
  type ParticleOperatorDefinition,
  ParticleOperatorRegistry,
} from '@forgeax/engine-vfx-compiler';
import { describe, expect, it } from 'vitest';

const MATERIAL_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';

const source: ParticleEffectSource = {
  schemaVersion: 1,
  emitters: [
    {
      id: 'spark',
      capacity: 16,
      space: 'world',
      schedule: { rate: 4, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: {} }],
        initialize: [{ kind: 'set-life', version: 1, params: {} }],
        update: [{ kind: 'gravity', version: 1, params: {} }],
        output: [{ kind: 'billboard', version: 1, params: {} }],
      },
      output: { kind: 'billboard', material: MATERIAL_GUID },
    },
  ],
};

function definition(stage: ParticleOperatorStage, kind: string): ParticleOperatorDefinition {
  return {
    stage,
    kind,
    version: 1,
    parameterSchema: {},
    validateParams: (): Result<void, never> => ok(undefined),
    compile: { cpu: (params) => ({ stage, kind, params }) },
  };
}

function registry(): ParticleOperatorRegistry {
  const operators = new ParticleOperatorRegistry();
  for (const [stage, kind] of [
    ['spawn', 'spawn-rate'],
    ['initialize', 'set-life'],
    ['update', 'gravity'],
    ['output', 'billboard'],
  ] satisfies readonly [ParticleOperatorStage, string][]) {
    const registered = operators.register(definition(stage, kind));
    if (!registered.ok) throw new Error(registered.error.hint);
  }
  return operators;
}

describe('fresh public AI compiler consumer path', () => {
  it('defines, validates, registers, and cooks a runtime asset by public APIs', () => {
    const defined = defineParticleEffectSource(source);
    expect(defined.ok).toBe(true);
    if (!defined.ok) return;

    const cooked = cookParticleEffect(defined.value, registry());
    expect(cooked.ok).toBe(true);
    if (!cooked.ok) return;
    expect(cooked.value.asset.kind).toBe('particle-effect');
    expect(cooked.value.refs.map((ref) => ref.guid)).toEqual([MATERIAL_GUID]);
    expect(cooked.value.program.bytes).toBeInstanceOf(Uint8Array);
    expect(cooked.value.outputDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});

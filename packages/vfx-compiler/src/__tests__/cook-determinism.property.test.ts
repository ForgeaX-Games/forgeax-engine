import { ok, type Result } from '@forgeax/engine-types';
import type { ParticleEffectSource } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import {
  cookParticleEffect,
  type ParticleOperatorDefinition,
  ParticleOperatorRegistry,
} from '../index.js';

const source = {
  schemaVersion: 1,
  emitters: [
    {
      id: 'trail',
      capacity: 64,
      space: 'local',
      schedule: { rate: 8, bursts: [] },
      bounds: { min: [-2, -2, -2], max: [2, 2, 2] },
      backendPolicy: { kind: 'preferred', backend: 'gpu', fallback: 'cpu' },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: { rate: 8 } }],
        initialize: [{ kind: 'set-life', version: 1, params: { seconds: 2 } }],
        update: [{ kind: 'drag', version: 1, params: { factor: 0.2 } }],
        output: [{ kind: 'billboard', version: 1, params: { size: 0.1 } }],
      },
      output: { kind: 'billboard', material: 'fx/trail' },
    },
  ],
} satisfies ParticleEffectSource;

function definition(
  stage: 'spawn' | 'initialize' | 'update' | 'output',
  kind: string,
): ParticleOperatorDefinition {
  return {
    stage,
    kind,
    version: 1,
    parameterSchema: {},
    validateParams: (): Result<void, never> => ok(undefined),
    compile: {
      cpu: (params) => ({ backend: 'cpu', kind, params }),
      gpu: (params) => ({ backend: 'gpu', kind, params }),
    },
  };
}

function registry(order: readonly string[]): ParticleOperatorRegistry {
  const definitions = new Map<string, ParticleOperatorDefinition>([
    ['spawn-rate', definition('spawn', 'spawn-rate')],
    ['set-life', definition('initialize', 'set-life')],
    ['drag', definition('update', 'drag')],
    ['billboard', definition('output', 'billboard')],
  ]);
  const result = new ParticleOperatorRegistry();
  for (const kind of order) {
    const item = definitions.get(kind);
    if (item === undefined) throw new Error(`missing fixture definition: ${kind}`);
    const registered = result.register(item);
    if (!registered.ok) throw new Error(registered.error.code);
  }
  return result;
}

function cook(order: readonly string[] = ['spawn-rate', 'set-life', 'drag', 'billboard']) {
  const result = cookParticleEffect(source, registry(order));
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`);
  return result.value;
}

function changedCook() {
  const changed = structuredClone(source);
  const emitter = changed.emitters[0];
  if (emitter === undefined) throw new Error('fixture emitter is missing');
  emitter.schedule.rate = 9;
  const result = cookParticleEffect(
    changed,
    registry(['spawn-rate', 'set-life', 'drag', 'billboard']),
  );
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.hint}`);
  return result.value;
}

function canonical(order: readonly string[] = ['spawn-rate', 'set-life', 'drag', 'billboard']) {
  return cook(order).program;
}

describe('cookParticleEffect deterministic properties', () => {
  it('keeps canonical payload, artifact bytes, fingerprint, and digest equal for 100 runs', () => {
    const expected = canonical();
    for (let index = 0; index < 100; index += 1) {
      const actual = canonical();
      expect(actual.bytes).toEqual(expected.bytes);
      expect(actual.fingerprint).toBe(expected.fingerprint);
      expect(actual.canonicalJson).toBe(expected.canonicalJson);
    }
  });

  it('ignores registry permutations and independent cache or restart state', () => {
    const first = canonical(['spawn-rate', 'set-life', 'drag', 'billboard']);
    const permuted = canonical(['billboard', 'drag', 'set-life', 'spawn-rate']);
    const restarted = canonical(['set-life', 'spawn-rate', 'billboard', 'drag']);

    expect(permuted.bytes).toEqual(first.bytes);
    expect(restarted.bytes).toEqual(first.bytes);
    expect(permuted.fingerprint).toBe(first.fingerprint);
    expect(restarted.fingerprint).toBe(first.fingerprint);
  });

  it('does not reuse an old result after a semantic source change', () => {
    const baseline = cook();
    const result = changedCook();

    expect(result.program.bytes).not.toEqual(baseline.program.bytes);
    expect(result.program.fingerprint).not.toBe(baseline.program.fingerprint);
    expect(result.outputDigest).not.toBe(baseline.outputDigest);
  });
});

import type { ParticleEffectSource } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import { canonicalizeParticleProgram, type ParticleProgramInput } from '../index.js';

const source = {
  schemaVersion: 1,
  emitters: [
    {
      id: 'spark',
      capacity: 32,
      space: 'world',
      schedule: { rate: 4, bursts: [] },
      bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
      backendPolicy: { kind: 'required', backend: 'cpu' },
      operators: {
        spawn: [{ kind: 'spawn-rate', version: 1, params: { rate: 4 } }],
        initialize: [{ kind: 'set-life', version: 1, params: { seconds: 1 } }],
        update: [
          { kind: 'gravity', version: 1, params: { y: -9.8 } },
          { kind: 'drag', version: 1, params: { factor: 0.2 } },
        ],
        output: [{ kind: 'billboard', version: 1, params: { size: 0.25 } }],
      },
      output: { kind: 'billboard', material: 'fx/spark' },
    },
  ],
} satisfies ParticleEffectSource;

function input(overrides: Partial<ParticleProgramInput> = {}): ParticleProgramInput {
  return {
    source,
    backendPlans: { spark: { kind: 'cpu', backends: ['cpu'] } },
    operatorPrograms: {
      'spawn:spawn-rate:1': { cpu: { opcode: 'spawn-rate', rate: 4 } },
      'initialize:set-life:1': { cpu: { opcode: 'set-life', seconds: 1 } },
      'update:gravity:1': { cpu: { opcode: 'gravity', y: -9.8 } },
      'update:drag:1': { cpu: { opcode: 'drag', factor: 0.2 } },
      'output:billboard:1': { cpu: { opcode: 'billboard', size: 0.25 } },
    },
    ...overrides,
  };
}

describe('canonicalizeParticleProgram', () => {
  it('emits a versioned asset-local artifact with canonical bytes and identity', () => {
    const result = canonicalizeParticleProgram(input());

    expect(result.format).toBe('forgeax-vfx-program-1');
    expect(result.artifactKey).toBe('particle-effect/program.json');
    expect(result.mimeType).toBe('application/json');
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(Array.from(result.bytes)).toEqual(Array.from(result.artifact.bytes));
    expect(new TextDecoder().decode(result.bytes)).toBe(result.canonicalJson);
    expect(JSON.parse(result.canonicalJson)).toEqual(result.payload);
  });

  it('sorts object keys without sorting semantic emitter or operator arrays', () => {
    const reordered = structuredClone(source);
    const emitter = reordered.emitters[0];
    if (emitter === undefined) throw new Error('fixture emitter is missing');
    emitter.operators.update = [...emitter.operators.update].reverse();
    const changed = canonicalizeParticleProgram(input({ source: reordered }));

    expect(changed.bytes).not.toEqual(canonicalizeParticleProgram(input()).bytes);
    expect(changed.payload.emitters[0]?.operators.update[0]?.kind).toBe('drag');
  });

  it('does not encode operator registry insertion order', () => {
    const programs = input().operatorPrograms;
    const permuted = Object.fromEntries(Object.entries(programs).reverse());

    const first = canonicalizeParticleProgram(input());
    const second = canonicalizeParticleProgram(input({ operatorPrograms: permuted }));

    expect(second.bytes).toEqual(first.bytes);
    expect(second.fingerprint).toBe(first.fingerprint);
  });
});

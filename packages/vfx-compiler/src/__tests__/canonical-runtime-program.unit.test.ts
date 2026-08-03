import type { ParticleRuntimeProgram } from '@forgeax/engine-vfx';
import { describe, expect, it } from 'vitest';
import {
  canonicalizeParticleProgram,
  PARTICLE_PROGRAM_ARTIFACT_KEY,
  PARTICLE_PROGRAM_FORMAT,
  type ParticleProgramInput,
} from '../index.js';

const input: ParticleProgramInput = {
  source: {
    schemaVersion: 1,
    emitters: [
      {
        id: 'spark',
        capacity: 16,
        space: 'world',
        schedule: { rate: 8, bursts: [] },
        bounds: { min: [-1, -1, -1], max: [1, 1, 1] },
        backendPolicy: { kind: 'required', backend: 'cpu' },
        operators: {
          spawn: [{ kind: 'spawn-rate', version: 1, params: { rate: 8 } }],
          initialize: [{ kind: 'set-life', version: 1, params: { seconds: 1 } }],
          update: [{ kind: 'gravity', version: 1, params: { y: -9.8 } }],
          output: [{ kind: 'billboard', version: 1, params: { size: 0.5 } }],
        },
        output: { kind: 'billboard', material: 'material-spark' },
      },
    ],
  },
  backendPlans: { spark: { kind: 'cpu', backends: ['cpu'] } },
  operatorPrograms: {
    spark: {
      'spawn:spawn-rate:1': { cpu: { opcode: 'spawn-rate', rate: 8 } },
      'initialize:set-life:1': { cpu: { opcode: 'set-life', seconds: 1 } },
      'update:gravity:1': { cpu: { opcode: 'gravity', y: -9.8 } },
      'output:billboard:1': { cpu: { opcode: 'billboard', size: 0.5 } },
    },
  },
};

describe('compiler canonical runtime program vocabulary', () => {
  it('emits the runtime-safe canonical program without a second format authority', () => {
    const artifact = canonicalizeParticleProgram(input);
    const runtimeProgram: ParticleRuntimeProgram = artifact.payload;

    expect(PARTICLE_PROGRAM_FORMAT).toBe('forgeax-vfx-program-1');
    expect(PARTICLE_PROGRAM_ARTIFACT_KEY).toBe('particle-effect/program.json');
    expect(runtimeProgram.format).toBe(PARTICLE_PROGRAM_FORMAT);
    expect(runtimeProgram.emitters[0]?.backendPlan).toEqual({ kind: 'cpu', backends: ['cpu'] });
    expect(runtimeProgram.emitters[0]?.programs.cpu).toEqual([
      { operator: 'spawn:spawn-rate:1', program: { opcode: 'spawn-rate', rate: 8 } },
      { operator: 'initialize:set-life:1', program: { opcode: 'set-life', seconds: 1 } },
      { operator: 'update:gravity:1', program: { opcode: 'gravity', y: -9.8 } },
      { operator: 'output:billboard:1', program: { opcode: 'billboard', size: 0.5 } },
    ]);
    expect(new TextDecoder().decode(artifact.bytes)).toBe(artifact.canonicalJson);
  });

  it('keeps the asset-local artifact identity and canonical bytes stable', () => {
    const first = canonicalizeParticleProgram(input);
    const second = canonicalizeParticleProgram(input);

    expect(first.artifact.key).toBe(PARTICLE_PROGRAM_ARTIFACT_KEY);
    expect(first.artifact.bytes).toEqual(second.artifact.bytes);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(JSON.parse(first.canonicalJson)).toEqual(first.payload);
  });
});

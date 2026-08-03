import { createHash } from 'node:crypto';
import type {
  ParticleEffectSource,
  ParticleRuntimeEmitter,
  ParticleRuntimeProgram,
} from '@forgeax/engine-vfx';
import { PARTICLE_PROGRAM_ARTIFACT_KEY, PARTICLE_PROGRAM_FORMAT } from '@forgeax/engine-vfx';
import type {
  ParticleBackend,
  ParticleBackendPlan,
  ParticleOperatorProgram,
} from './operator-registry.js';

export { PARTICLE_PROGRAM_ARTIFACT_KEY, PARTICLE_PROGRAM_FORMAT } from '@forgeax/engine-vfx';

/** Compiled operator programs scoped by emitter, then operator identity. */
export type ParticleEmitterOperatorPrograms = Readonly<
  Record<
    string,
    Readonly<Record<string, Readonly<Partial<Record<ParticleBackend, ParticleOperatorProgram>>>>>
  >
>;

export interface ParticleProgramInput {
  readonly source: ParticleEffectSource;
  readonly backendPlans: Readonly<Record<string, ParticleBackendPlan>>;
  readonly operatorPrograms: ParticleEmitterOperatorPrograms;
}

export type CanonicalParticleProgram = ParticleRuntimeProgram;
export type CanonicalParticleEmitter = ParticleRuntimeEmitter;

export interface ParticleProgramArtifact {
  readonly format: typeof PARTICLE_PROGRAM_FORMAT;
  readonly artifactKey: typeof PARTICLE_PROGRAM_ARTIFACT_KEY;
  readonly mimeType: 'application/json';
  readonly canonicalJson: string;
  readonly bytes: Uint8Array;
  readonly fingerprint: string;
  readonly payload: CanonicalParticleProgram;
  readonly artifact: {
    readonly key: typeof PARTICLE_PROGRAM_ARTIFACT_KEY;
    readonly mimeType: 'application/json';
    readonly bytes: Uint8Array;
  };
}

function keyOf(stage: string, kind: string, version: number): string {
  return `${stage}:${kind}:${version}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value === null || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, sortJson(record[key])]),
  );
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function digestOf(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function canonicalProgramsForEmitter(
  emitter: ParticleEffectSource['emitters'][number],
  backendPlan: ParticleBackendPlan,
  operatorPrograms: ParticleEmitterOperatorPrograms,
): CanonicalParticleEmitter['programs'] {
  const programs: Partial<
    Record<ParticleBackend, readonly { readonly operator: string; readonly program: unknown }[]>
  > = {};
  const stages = ['spawn', 'initialize', 'update', 'output'] as const;
  for (const backend of backendPlan.backends) {
    const backendPrograms: { operator: string; program: unknown }[] = [];
    const emitterPrograms = operatorPrograms[emitter.id] ?? {};
    for (const stage of stages) {
      for (const operator of emitter.operators[stage]) {
        const key = keyOf(stage, operator.kind, operator.version);
        backendPrograms.push({ operator: key, program: emitterPrograms[key]?.[backend] });
      }
    }
    programs[backend] = backendPrograms;
  }
  return programs as CanonicalParticleEmitter['programs'];
}

function canonicalEmitter(
  emitter: ParticleEffectSource['emitters'][number],
  backendPlan: ParticleBackendPlan,
  operatorPrograms: ParticleEmitterOperatorPrograms,
): CanonicalParticleEmitter {
  const programs = canonicalProgramsForEmitter(emitter, backendPlan, operatorPrograms);

  return {
    id: emitter.id,
    capacity: emitter.capacity,
    space: emitter.space,
    schedule: emitter.schedule,
    bounds: emitter.bounds,
    backendPolicy: emitter.backendPolicy,
    backendPlan,
    operators: emitter.operators,
    ...(emitter.curves === undefined ? {} : { curves: emitter.curves }),
    ...(emitter.gradients === undefined ? {} : { gradients: emitter.gradients }),
    output: emitter.output,
    programs,
  };
}

export function canonicalizeParticleProgram(input: ParticleProgramInput): ParticleProgramArtifact {
  const emitters = input.source.emitters.map((emitter) => {
    const backendPlan = input.backendPlans[emitter.id];
    if (backendPlan === undefined) {
      throw new Error(`missing backend plan for emitter ${emitter.id}`);
    }
    return canonicalEmitter(emitter, backendPlan, input.operatorPrograms);
  });
  const payload = sortJson({
    format: PARTICLE_PROGRAM_FORMAT,
    emitters,
  }) as CanonicalParticleProgram;
  const canonicalJson = JSON.stringify(payload);
  const bytes = bytesOf(canonicalJson);
  const fingerprint = digestOf(bytes);
  const artifact = {
    key: PARTICLE_PROGRAM_ARTIFACT_KEY,
    mimeType: 'application/json' as const,
    bytes,
  };
  return {
    format: PARTICLE_PROGRAM_FORMAT,
    artifactKey: PARTICLE_PROGRAM_ARTIFACT_KEY,
    mimeType: 'application/json',
    canonicalJson,
    bytes,
    fingerprint,
    payload,
    artifact,
  };
}

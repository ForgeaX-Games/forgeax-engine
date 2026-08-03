import type { LoadContext, ParticleEffectAsset, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { type VfxCause, type VfxError, vfxError } from './errors.js';
import {
  deepFreeze,
  type LoadedParticleEffect,
  PARTICLE_PROGRAM_FORMAT,
  type ParticleRuntimeBackendPlan,
  type ParticleRuntimeProgram,
  type ParticleRuntimeStageProgram,
} from './runtime-program.js';
import { normalizeParticleEffectSource } from './source.js';

const PROGRAM_ARTIFACT = 'particle-effect/program.json';
const ASSET_LOCAL_PACKAGE = '<asset-local>';

interface PackArtifactInput {
  readonly descriptor: { readonly path: string; readonly mediaType: string };
  readonly bytes: Uint8Array;
}

interface PackLoaderInput {
  readonly guid: string;
  readonly kind: string;
  readonly payload: Record<string, unknown>;
  readonly refs: readonly string[];
  readonly artifacts: Readonly<Record<string, PackArtifactInput>>;
}

function cause(code: string, expected: string, hint: string): VfxCause {
  return { code, expected, hint };
}

function failure(guid: string, artifact: string, failureCause: VfxCause): Result<never, VfxError> {
  return err(
    vfxError('vfx-asset-load-failed', {
      guid,
      stage: 'artifact',
      packageUrl: ASSET_LOCAL_PACKAGE,
      artifact,
      cause: failureCause,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parsePayload(input: PackLoaderInput): Result<ParticleEffectAsset, VfxError> {
  const payload = input.payload;
  if (
    payload.kind !== 'particle-effect' ||
    payload.schemaVersion !== 1 ||
    !Array.isArray(payload.emitters) ||
    payload.emitters.length === 0
  ) {
    return failure(
      input.guid,
      PROGRAM_ARTIFACT,
      cause(
        'vfx-payload-invalid',
        'Pack v2 payload to match ParticleEffectAsset schemaVersion 1',
        'recook the particle effect and keep the cooked payload beside its asset-local program',
      ),
    );
  }

  const emitters: { id: string; capacity: number }[] = [];
  const emitterIds = new Set<string>();
  for (const emitter of payload.emitters) {
    if (
      !isRecord(emitter) ||
      typeof emitter.id !== 'string' ||
      emitter.id.length === 0 ||
      emitterIds.has(emitter.id) ||
      typeof emitter.capacity !== 'number' ||
      !Number.isFinite(emitter.capacity) ||
      emitter.capacity <= 0
    ) {
      return failure(
        input.guid,
        PROGRAM_ARTIFACT,
        cause(
          'vfx-payload-invalid',
          'every particle emitter to provide a non-empty unique id and finite positive capacity',
          'recook the particle effect after repairing the emitter payload',
        ),
      );
    }
    emitterIds.add(emitter.id);
    emitters.push({ id: emitter.id, capacity: emitter.capacity });
  }
  return ok({ kind: 'particle-effect', schemaVersion: 1, emitters });
}

function programFailure(
  input: PackLoaderInput,
  path: string,
  expected: string,
  hint: string,
): Result<never, VfxError> {
  return failure(
    input.guid,
    PROGRAM_ARTIFACT,
    cause('vfx-program-invalid', `${expected} at ${path}`, hint),
  );
}

function expectedPlanKind(policy: unknown): ParticleRuntimeBackendPlan['kind'] | undefined {
  if (!isRecord(policy)) return undefined;
  if (policy.kind === 'required' && policy.backend === 'cpu') return 'cpu';
  if (policy.kind === 'required' && policy.backend === 'gpu') return 'gpu';
  if (policy.kind === 'preferred' && policy.backend === 'gpu' && policy.fallback === 'cpu') {
    return 'gpu-with-cpu-fallback';
  }
  if (policy.kind === 'preferred' && policy.backend === 'gpu' && policy.fallback === 'disable') {
    return 'gpu-or-disable';
  }
  return undefined;
}

function parseBackendPlan(
  input: PackLoaderInput,
  emitter: Record<string, unknown>,
  path: string,
): Result<ParticleRuntimeBackendPlan, VfxError> {
  if (!isRecord(emitter.backendPlan)) {
    return programFailure(
      input,
      `${path}.backendPlan`,
      'a backend plan object',
      'recook the particle effect with its canonical backend plan',
    );
  }
  const plan = emitter.backendPlan;
  if (
    (plan.kind !== 'cpu' &&
      plan.kind !== 'gpu' &&
      plan.kind !== 'gpu-with-cpu-fallback' &&
      plan.kind !== 'gpu-or-disable') ||
    !Array.isArray(plan.backends) ||
    plan.backends.length === 0 ||
    plan.backends.some((backend) => backend !== 'cpu' && backend !== 'gpu') ||
    new Set(plan.backends).size !== plan.backends.length
  ) {
    return programFailure(
      input,
      `${path}.backendPlan`,
      'a closed backend plan with unique cpu/gpu entries',
      'recook the particle effect and restore its backend policy plan',
    );
  }
  const backends = plan.backends as ParticleRuntimeBackendPlan['backends'];
  const expectedBackends: Record<ParticleRuntimeBackendPlan['kind'], readonly string[]> = {
    cpu: ['cpu'],
    gpu: ['gpu'],
    'gpu-with-cpu-fallback': ['gpu', 'cpu'],
    'gpu-or-disable': ['gpu'],
  };
  if (JSON.stringify(backends) !== JSON.stringify(expectedBackends[plan.kind])) {
    return programFailure(
      input,
      `${path}.backendPlan.backends`,
      `backend entries to match plan kind ${plan.kind}`,
      'recook the particle effect so backend policy and plan are produced together',
    );
  }
  return ok({ kind: plan.kind, backends });
}

function parsePrograms(
  input: PackLoaderInput,
  emitter: Record<string, unknown>,
  plan: ParticleRuntimeBackendPlan,
  path: string,
): Result<Readonly<Record<'cpu' | 'gpu', readonly ParticleRuntimeStageProgram[]>>, VfxError> {
  if (!isRecord(emitter.programs)) {
    return programFailure(
      input,
      `${path}.programs`,
      'ordered programs for every planned backend',
      'recook the particle effect with all canonical stage programs',
    );
  }
  const programs = emitter.programs;
  const keys = Object.keys(programs).sort();
  const expectedKeys = [...plan.backends].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    return programFailure(
      input,
      `${path}.programs`,
      'program entries to match the backend plan',
      'recook the particle effect without adding or removing backend programs',
    );
  }

  const stageNames = ['spawn', 'initialize', 'update', 'output'] as const;
  const operators = isRecord(emitter.operators) ? emitter.operators : undefined;
  if (operators === undefined) {
    return programFailure(
      input,
      `${path}.operators`,
      'ordered operators for every stage',
      'recook the particle effect with its canonical operators',
    );
  }
  const expectedOperators: string[] = [];
  for (const stage of stageNames) {
    const stageOperators = operators[stage];
    if (!Array.isArray(stageOperators)) {
      return programFailure(
        input,
        `${path}.operators.${stage}`,
        'an ordered operator array',
        'recook the particle effect with all canonical stages',
      );
    }
    for (const [index, value] of stageOperators.entries()) {
      if (!isRecord(value) || typeof value.kind !== 'string' || !Number.isInteger(value.version)) {
        return programFailure(
          input,
          `${path}.operators.${stage}[${index}]`,
          'a stage operator with kind and version',
          'recook the particle effect with valid operator records',
        );
      }
      expectedOperators.push(`${stage}:${value.kind}:${value.version}`);
    }
  }

  const parsed: Partial<Record<'cpu' | 'gpu', readonly ParticleRuntimeStageProgram[]>> = {};
  for (const backend of plan.backends) {
    const entries = programs[backend];
    if (!Array.isArray(entries) || entries.length !== expectedOperators.length) {
      return programFailure(
        input,
        `${path}.programs.${backend}`,
        'one ordered program for every operator',
        'recook the particle effect with complete backend programs',
      );
    }
    const validated: ParticleRuntimeStageProgram[] = [];
    for (const [index, entry] of entries.entries()) {
      const expectedOperator = expectedOperators[index];
      if (
        expectedOperator === undefined ||
        !isRecord(entry) ||
        entry.operator !== expectedOperator ||
        !Object.hasOwn(entry, 'program')
      ) {
        return programFailure(
          input,
          `${path}.programs.${backend}[${index}]`,
          `the ordered program ${expectedOperator}`,
          'recook the particle effect with canonical stage program order',
        );
      }
      validated.push({ operator: expectedOperator, program: entry.program });
    }
    parsed[backend] = validated;
  }
  return ok(parsed as Readonly<Record<'cpu' | 'gpu', readonly ParticleRuntimeStageProgram[]>>);
}

function parseProgram(
  input: PackLoaderInput,
  payload: ParticleEffectAsset,
): Result<ParticleRuntimeProgram, VfxError> {
  const artifact = input.artifacts[PROGRAM_ARTIFACT];
  if (artifact === undefined) {
    return failure(
      input.guid,
      PROGRAM_ARTIFACT,
      cause(
        'vfx-artifact-missing',
        `asset-local artifact ${PROGRAM_ARTIFACT} to be present`,
        'recook the particle effect; runtime VFX does not load package-global artifacts or source files',
      ),
    );
  }
  if (artifact.descriptor.mediaType !== 'application/json') {
    return failure(
      input.guid,
      PROGRAM_ARTIFACT,
      cause(
        'vfx-program-invalid',
        'the particle program artifact to use application/json',
        'recook the particle effect with the canonical JSON program artifact',
      ),
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(artifact.bytes));
  } catch {
    return failure(
      input.guid,
      PROGRAM_ARTIFACT,
      cause(
        'vfx-program-invalid',
        `asset-local artifact ${PROGRAM_ARTIFACT} to contain valid JSON`,
        'recook the particle effect and restore the canonical program bytes',
      ),
    );
  }
  if (
    !isRecord(decoded) ||
    decoded.format !== PARTICLE_PROGRAM_FORMAT ||
    !Array.isArray(decoded.emitters)
  ) {
    return programFailure(
      input,
      'format',
      `program format ${PARTICLE_PROGRAM_FORMAT} with an emitter entry for every payload emitter`,
      'recook the particle effect and keep the canonical program format',
    );
  }
  if (decoded.emitters.length !== payload.emitters.length) {
    return programFailure(
      input,
      'emitters',
      'one program emitter for every payload emitter',
      'recook the particle effect so payload and program are produced atomically',
    );
  }

  const authoredEmitters = decoded.emitters.map((emitter) => {
    if (!isRecord(emitter)) return emitter;
    const { backendPlan: _backendPlan, programs: _programs, ...authored } = emitter;
    return authored;
  });
  const source = normalizeParticleEffectSource({ schemaVersion: 1, emitters: authoredEmitters });
  if (!source.ok) {
    return programFailure(
      input,
      source.error.detail.path,
      source.error.expected,
      source.error.hint,
    );
  }
  const emitters = [];
  for (const [index, sourceEmitter] of source.value.emitters.entries()) {
    const decodedEmitter = decoded.emitters[index];
    const payloadEmitter = payload.emitters[index];
    if (!isRecord(decodedEmitter) || payloadEmitter === undefined) {
      return programFailure(
        input,
        `emitters[${index}]`,
        'a complete canonical emitter',
        'recook the particle effect with complete emitter records',
      );
    }
    if (
      sourceEmitter.id !== payloadEmitter.id ||
      sourceEmitter.capacity !== payloadEmitter.capacity
    ) {
      return programFailure(
        input,
        `emitters[${index}].id`,
        'program emitter identity and capacity to match the payload',
        'recook the particle effect so payload and program are produced atomically',
      );
    }
    const plan = parseBackendPlan(input, decodedEmitter, `emitters[${index}]`);
    if (!plan.ok) return plan;
    if (expectedPlanKind(sourceEmitter.backendPolicy) !== plan.value.kind) {
      return programFailure(
        input,
        `emitters[${index}].backendPlan.kind`,
        'backend plan kind to match backend policy',
        'recook the particle effect so backend policy and plan are produced together',
      );
    }
    const programs = parsePrograms(input, decodedEmitter, plan.value, `emitters[${index}]`);
    if (!programs.ok) return programs;
    emitters.push({ ...sourceEmitter, backendPlan: plan.value, programs: programs.value });
  }
  return ok(deepFreeze({ format: PARTICLE_PROGRAM_FORMAT, emitters }));
}

function loadedEffect(
  payload: ParticleEffectAsset,
  program: ParticleRuntimeProgram,
): LoadedParticleEffect {
  const loaded = { ...payload } as LoadedParticleEffect;
  Object.defineProperty(loaded, 'program', {
    configurable: false,
    enumerable: false,
    value: program,
    writable: false,
  });
  return Object.freeze(loaded);
}

export const particleEffectPackLoader = {
  kind: 'particle-effect',
  async load(
    input: PackLoaderInput,
    _ctx: LoadContext,
  ): Promise<Result<LoadedParticleEffect, VfxError>> {
    const payload = parsePayload(input);
    if (!payload.ok) return payload;
    const program = parseProgram(input, payload.value);
    if (!program.ok) return program;

    return ok(loadedEffect(payload.value, program.value));
  },
};

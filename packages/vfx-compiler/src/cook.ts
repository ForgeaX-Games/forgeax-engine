import { createHash } from 'node:crypto';
import {
  type AssetRef,
  err,
  ok,
  type ParticleEffectAsset,
  type Result,
} from '@forgeax/engine-types';
import {
  normalizeParticleEffectSource,
  type ParticleEffectSource,
  type ParticleOperatorKey,
  type VfxError,
} from '@forgeax/engine-vfx';
import { canonicalizeParticleProgram, type ParticleProgramArtifact } from './canonicalize.js';
import type {
  ParticleBackendPlan,
  ParticleOperatorRegistry,
  ParticleOperatorRegistryError,
} from './operator-registry.js';

export interface ParticleCookProduct {
  readonly asset: ParticleEffectAsset;
  readonly refs: readonly AssetRef[];
  readonly backendPlans: readonly ParticleBackendPlan[];
  readonly program: ParticleProgramArtifact;
  readonly outputDigest: string;
}

export type ParticleCookError = VfxError | ParticleOperatorRegistryError;

function operatorKey(stage: string, kind: string, version: number): string {
  return `${stage}:${kind}:${version}`;
}

function digestProduct(
  asset: ParticleEffectAsset,
  refs: readonly AssetRef[],
  program: ParticleProgramArtifact,
): string {
  return createHash('sha256')
    .update(program.bytes)
    .update(JSON.stringify(asset))
    .update(JSON.stringify(refs))
    .digest('hex');
}

function appendRef(refs: AssetRef[], guid: string): void {
  if (!refs.some((ref) => ref.guid === guid)) refs.push({ guid });
}

function compileEmitter(
  emitter: ParticleEffectSource['emitters'][number],
  registry: ParticleOperatorRegistry,
): Result<
  {
    readonly plan: ParticleBackendPlan;
    readonly operators: readonly ParticleOperatorKey[];
    readonly programs: Readonly<Record<string, Readonly<Partial<Record<'cpu' | 'gpu', unknown>>>>>;
  },
  ParticleOperatorRegistryError
> {
  const operators: ParticleOperatorKey[] = [];
  const programs: Record<string, Partial<Record<'cpu' | 'gpu', unknown>>> = {};
  const stages = ['spawn', 'initialize', 'update', 'output'] as const;

  for (const stage of stages) {
    for (const operator of emitter.operators[stage]) {
      const key = {
        stage,
        kind: operator.kind,
        version: operator.version,
      } satisfies ParticleOperatorKey;
      const definition = registry.resolve(stage, operator.kind, operator.version, emitter.id);
      if (!definition.ok) return definition;
      const params = definition.value.validateParams(operator.params);
      if (!params.ok) return params;
      operators.push(key);
    }
  }

  const plan = registry.resolveBackendPlan({
    emitterId: emitter.id,
    operators,
    policy: emitter.backendPolicy,
  });
  if (!plan.ok) return plan;

  for (const backend of plan.value.backends) {
    for (const operator of operators) {
      const definition = registry.resolve(
        operator.stage,
        operator.kind,
        operator.version,
        emitter.id,
      );
      if (!definition.ok) return definition;
      const compiler = definition.value.compile[backend];
      if (compiler === undefined) {
        return err({
          code: 'vfx-operator-backend-unsupported',
          expected: `every operator has a ${backend} compiler`,
          hint: 'register the missing backend compiler or change the explicit source policy',
          detail: { ...operator, emitterId: emitter.id, operator, backend },
        });
      }
      const sourceOperator = emitter.operators[operator.stage].find(
        (item) => item.kind === operator.kind && item.version === operator.version,
      );
      if (sourceOperator === undefined) continue;
      const compiled = (compiler as (params: unknown) => unknown)(sourceOperator.params);
      const existing = programs[operatorKey(operator.stage, operator.kind, operator.version)] ?? {};
      existing[backend] = compiled;
      programs[operatorKey(operator.stage, operator.kind, operator.version)] = existing;
    }
  }

  return ok({ plan: plan.value, operators, programs });
}

export function cookParticleEffect(
  source: unknown,
  registry: ParticleOperatorRegistry,
): Result<ParticleCookProduct, ParticleCookError> {
  const parsed = normalizeParticleEffectSource(source);
  if (!parsed.ok) return parsed;

  const backendPlans: Record<string, ParticleBackendPlan> = {};
  const operatorPrograms: Record<string, Partial<Record<'cpu' | 'gpu', unknown>>> = {};
  const refs: AssetRef[] = [];
  const emitters: { readonly id: string; readonly capacity: number }[] = [];

  for (const emitter of parsed.value.emitters) {
    const compiled = compileEmitter(emitter, registry);
    if (!compiled.ok) return compiled;
    backendPlans[emitter.id] = compiled.value.plan;
    for (const [key, programs] of Object.entries(compiled.value.programs)) {
      operatorPrograms[key] = programs;
    }
    emitters.push({ id: emitter.id, capacity: emitter.capacity });
    appendRef(refs, emitter.output.material);
    if (emitter.output.kind === 'mesh') appendRef(refs, emitter.output.mesh);
  }

  const program = canonicalizeParticleProgram({
    source: parsed.value,
    backendPlans,
    operatorPrograms,
  });
  const asset: ParticleEffectAsset = {
    kind: 'particle-effect',
    schemaVersion: 1,
    emitters,
  };
  return ok({
    asset,
    refs,
    backendPlans: parsed.value.emitters.map(
      (emitter) => backendPlans[emitter.id] as ParticleBackendPlan,
    ),
    program,
    outputDigest: digestProduct(asset, refs, program),
  });
}

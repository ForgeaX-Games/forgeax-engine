import { err, ok, type Result } from '@forgeax/engine-types';
import type {
  ParticleBackend,
  ParticleBackendPolicy,
  ParticleOperatorStage,
  ParticleRuntimeBackendPlan,
} from '@forgeax/engine-vfx';

export type {
  ParticleBackend,
  ParticleBackendPolicy,
  ParticleOperatorStage,
  ParticleRuntimeBackendPlan,
} from '@forgeax/engine-vfx';

export type ParticleBackendPlan = ParticleRuntimeBackendPlan;

export interface ParticleOperatorKey {
  readonly stage: ParticleOperatorStage;
  readonly kind: string;
  readonly version: number;
}

export type ParticleOperatorProgram = unknown;

export type ParticleOperatorCompiler<Params> = (params: Params) => ParticleOperatorProgram;

export interface ParticleOperatorDefinition<Params = unknown> extends ParticleOperatorKey {
  readonly parameterSchema: Readonly<Record<string, unknown>>;
  readonly validateParams: (params: unknown) => Result<void, ParticleOperatorRegistryError>;
  readonly compile: Readonly<Partial<Record<ParticleBackend, ParticleOperatorCompiler<Params>>>>;
}

export interface ParticleOperatorParamsInvalidDetail extends ParticleOperatorKey {
  readonly path: string;
  readonly emitterId?: string;
  readonly operator?: ParticleOperatorKey;
  readonly backend?: ParticleBackend;
}

export interface ParticleOperatorUnknownDetail extends ParticleOperatorKey {
  readonly emitterId?: string;
  readonly operator?: ParticleOperatorKey;
  readonly backend?: ParticleBackend;
}

export interface ParticleOperatorConflictDetail extends ParticleOperatorKey {
  readonly emitterId?: string;
  readonly operator?: ParticleOperatorKey;
  readonly backend?: ParticleBackend;
}

export interface ParticleOperatorBackendUnsupportedDetail extends ParticleOperatorKey {
  readonly emitterId: string;
  readonly operator: ParticleOperatorKey;
  readonly backend: ParticleBackend;
}

export type ParticleOperatorRegistryError =
  | {
      readonly code: 'vfx-operator-params-invalid';
      readonly expected: string;
      readonly hint: string;
      readonly detail: ParticleOperatorParamsInvalidDetail;
    }
  | {
      readonly code: 'vfx-operator-unknown';
      readonly expected: string;
      readonly hint: string;
      readonly detail: ParticleOperatorUnknownDetail;
    }
  | {
      readonly code: 'vfx-operator-conflict';
      readonly expected: string;
      readonly hint: string;
      readonly detail: ParticleOperatorConflictDetail;
    }
  | {
      readonly code: 'vfx-operator-backend-unsupported';
      readonly expected: string;
      readonly hint: string;
      readonly detail: ParticleOperatorBackendUnsupportedDetail;
    };

export interface ParticleBackendPlanRequest {
  readonly emitterId: string;
  readonly operators: readonly ParticleOperatorKey[];
  readonly policy: ParticleBackendPolicy;
}

function keyOf(key: ParticleOperatorKey): string {
  return `${key.stage}:${key.kind}:${key.version}`;
}

function unknown(
  key: ParticleOperatorKey,
  emitterId?: string,
): ResultErr<ParticleOperatorRegistryError> {
  return err({
    code: 'vfx-operator-unknown',
    expected: 'the operator definition is registered for its stage, kind, and version',
    hint: 'register a definition before validating or cooking this source',
    detail: emitterId === undefined ? key : { ...key, emitterId },
  });
}

function conflict(key: ParticleOperatorKey): ResultErr<ParticleOperatorRegistryError> {
  return err({
    code: 'vfx-operator-conflict',
    expected: 'one definition per stage, kind, and version key',
    hint: 'remove the duplicate registration or choose a new version',
    detail: key,
  });
}

function unsupported(
  key: ParticleOperatorKey,
  emitterId: string,
  backend: ParticleBackend,
): ResultErr<ParticleOperatorRegistryError> {
  return err({
    code: 'vfx-operator-backend-unsupported',
    expected: `every operator has a ${backend} compiler`,
    hint: 'register the missing backend compiler or change the explicit source policy',
    detail: { ...key, emitterId, operator: key, backend },
  });
}

export class ParticleOperatorRegistry {
  readonly #definitions = new Map<string, ParticleOperatorDefinition<never>>();

  constructor(definitions: readonly ParticleOperatorDefinition<never>[] = []) {
    for (const definition of definitions) {
      const key = keyOf(definition);
      if (!this.#definitions.has(key)) this.#definitions.set(key, definition);
    }
  }

  register<Params>(
    definition: ParticleOperatorDefinition<Params>,
  ): Result<void, ParticleOperatorRegistryError> {
    const key = keyOf(definition);
    if (this.#definitions.has(key)) return conflict(definition);
    this.#definitions.set(key, definition as ParticleOperatorDefinition<never>);
    return ok(undefined);
  }

  resolve(
    stage: ParticleOperatorStage,
    kind: string,
    version: number,
    emitterId?: string,
  ): Result<ParticleOperatorDefinition<never>, ParticleOperatorRegistryError> {
    const key = { stage, kind, version } satisfies ParticleOperatorKey;
    const definition = this.#definitions.get(keyOf(key));
    return definition === undefined ? unknown(key, emitterId) : ok(definition);
  }

  list(): readonly ParticleOperatorDefinition<never>[] {
    return [...this.#definitions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, definition]) => definition);
  }

  resolveBackendPlan(
    request: ParticleBackendPlanRequest,
  ): Result<ParticleBackendPlan, ParticleOperatorRegistryError> {
    const requiredBackends = backendsFor(request.policy);
    for (const backend of requiredBackends) {
      for (const operator of request.operators) {
        const definition = this.resolve(
          operator.stage,
          operator.kind,
          operator.version,
          request.emitterId,
        );
        if (!definition.ok) return definition;
        if (definition.value.compile[backend] === undefined) {
          return unsupported(operator, request.emitterId, backend);
        }
      }
    }
    return ok({ kind: planKind(request.policy), backends: requiredBackends });
  }
}

function backendsFor(policy: ParticleBackendPolicy): readonly ParticleBackend[] {
  if (policy.kind === 'required') return [policy.backend];
  return policy.fallback === 'cpu' ? ['gpu', 'cpu'] : ['gpu'];
}

function planKind(policy: ParticleBackendPolicy): ParticleBackendPlan['kind'] {
  if (policy.kind === 'required') return policy.backend;
  return policy.fallback === 'cpu' ? 'gpu-with-cpu-fallback' : 'gpu-or-disable';
}

type ResultErr<E> = Extract<Result<never, E>, { readonly ok: false }>;

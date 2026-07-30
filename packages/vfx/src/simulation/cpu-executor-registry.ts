import { type VfxErrorFor, vfxError } from '../errors.js';
import type { ParticleRuntimeProgram, ParticleRuntimeStageProgram } from '../runtime-program.js';
import type {
  ParticleCpuExecutorContext,
  ParticleCpuExecutorResult,
  ParticleCpuExecutorStage,
} from './types.js';

export interface ParticleCpuExecutorDefinition {
  readonly stage: ParticleCpuExecutorStage;
  readonly kind: string;
  readonly version: number;
  readonly validateProgram: (program: unknown) => ParticleCpuExecutorResult<void, string>;
  readonly execute: (
    context: ParticleCpuExecutorContext,
  ) => ParticleCpuExecutorResult<void, string>;
}

export interface ParticleCpuExecutorEntry extends ParticleCpuExecutorDefinition {
  readonly key: string;
}

export type ParticleCpuExecutorRegistryError = VfxErrorFor<'vfx-simulation-execution-failed'>;

const stages: readonly ParticleCpuExecutorStage[] = ['spawn', 'initialize', 'update', 'output'];

export function particleCpuExecutorKey(
  stage: ParticleCpuExecutorStage,
  kind: string,
  version: number,
): string {
  return `${stage}:${kind}:${version}`;
}

function failure(
  player: number,
  emitterId: string,
  stage: ParticleCpuExecutorStage,
  operator: string,
  reason: string,
): ParticleCpuExecutorRegistryError {
  return vfxError('vfx-simulation-execution-failed', {
    player,
    emitterId,
    stage,
    operator,
    reason,
  });
}

function parseOperator(
  operator: string,
): ParticleCpuExecutorResult<
  { readonly stage: ParticleCpuExecutorStage; readonly kind: string; readonly version: number },
  { readonly stage: ParticleCpuExecutorStage; readonly reason: string }
> {
  const separator = operator.indexOf(':');
  const stage = operator.slice(0, separator) as ParticleCpuExecutorStage;
  if (!stages.includes(stage))
    return { ok: false, error: { stage: 'spawn', reason: 'unknown stage' } };
  const rest = operator.slice(separator + 1);
  const versionSeparator = rest.lastIndexOf(':');
  const kind = rest.slice(0, versionSeparator);
  const versionText = rest.slice(versionSeparator + 1);
  if (kind.length === 0 || !/^\d+$/.test(versionText)) {
    return { ok: false, error: { stage, reason: 'operator key must end with an integer version' } };
  }
  const version = Number(versionText);
  if (!Number.isSafeInteger(version) || version < 1) {
    return { ok: false, error: { stage, reason: 'operator version must be a positive integer' } };
  }
  return { ok: true, value: { stage, kind, version } };
}

export class ParticleCpuExecutorRegistry {
  readonly #definitions = new Map<string, ParticleCpuExecutorEntry>();

  constructor(definitions: readonly ParticleCpuExecutorDefinition[] = []) {
    for (const definition of definitions) {
      const key = particleCpuExecutorKey(definition.stage, definition.kind, definition.version);
      if (!this.#definitions.has(key)) this.#definitions.set(key, { ...definition, key });
    }
  }

  register(
    definition: ParticleCpuExecutorDefinition,
  ): ParticleCpuExecutorResult<void, ParticleCpuExecutorRegistryError> {
    const key = particleCpuExecutorKey(definition.stage, definition.kind, definition.version);
    if (this.#definitions.has(key)) {
      return {
        ok: false,
        error: failure(0, '', definition.stage, key, 'executor key is already registered'),
      };
    }
    this.#definitions.set(key, { ...definition, key });
    return { ok: true, value: undefined };
  }

  resolve(
    stage: ParticleCpuExecutorStage,
    kind: string,
    version: number,
    player = 0,
    emitterId = '',
  ): ParticleCpuExecutorResult<ParticleCpuExecutorEntry, ParticleCpuExecutorRegistryError> {
    const key = particleCpuExecutorKey(stage, kind, version);
    const definition = this.#definitions.get(key);
    if (definition === undefined) {
      return {
        ok: false,
        error: failure(player, emitterId, stage, key, 'CPU executor definition is missing'),
      };
    }
    return { ok: true, value: definition };
  }

  list(): readonly ParticleCpuExecutorEntry[] {
    return [...this.#definitions.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, definition]) => definition);
  }

  checkProgram(
    program: ParticleRuntimeProgram,
    emitterId: string,
    player = 0,
  ): ParticleCpuExecutorResult<void, ParticleCpuExecutorRegistryError> {
    const emitter = program.emitters.find((candidate) => candidate.id === emitterId);
    if (emitter === undefined) {
      return {
        ok: false,
        error: failure(
          player,
          emitterId,
          'spawn',
          'program',
          'emitter is missing from the program',
        ),
      };
    }
    const cpuPrograms = emitter.programs.cpu;
    if (cpuPrograms === undefined) {
      return {
        ok: false,
        error: failure(player, emitterId, 'spawn', 'cpu', 'the emitter has no CPU program'),
      };
    }
    for (const stageProgram of cpuPrograms) {
      const parsed = parseOperator(stageProgram.operator);
      if (!parsed.ok) {
        return {
          ok: false,
          error: failure(
            player,
            emitterId,
            parsed.error.stage,
            stageProgram.operator,
            parsed.error.reason,
          ),
        };
      }
      const resolved = this.resolve(
        parsed.value.stage,
        parsed.value.kind,
        parsed.value.version,
        player,
        emitterId,
      );
      if (!resolved.ok) return resolved;
      const validated = resolved.value.validateProgram(stageProgram.program);
      if (!validated.ok) {
        return {
          ok: false,
          error: failure(
            player,
            emitterId,
            parsed.value.stage,
            stageProgram.operator,
            validated.error,
          ),
        };
      }
    }
    return { ok: true, value: undefined };
  }

  resolveProgram(
    stageProgram: ParticleRuntimeStageProgram,
    player: number,
    emitterId: string,
  ): ParticleCpuExecutorResult<ParticleCpuExecutorEntry, ParticleCpuExecutorRegistryError> {
    const parsed = parseOperator(stageProgram.operator);
    if (!parsed.ok) {
      return {
        ok: false,
        error: failure(
          player,
          emitterId,
          parsed.error.stage,
          stageProgram.operator,
          parsed.error.reason,
        ),
      };
    }
    return this.resolve(
      parsed.value.stage,
      parsed.value.kind,
      parsed.value.version,
      player,
      emitterId,
    );
  }
}

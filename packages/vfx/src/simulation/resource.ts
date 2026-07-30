import type { EntityHandle, FixedTimeResource, World } from '@forgeax/engine-ecs';
import { FixedTime } from '@forgeax/engine-ecs';
import type { Handle, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { type VfxError, vfxError } from '../errors.js';
import {
  createParticleRenderBatch,
  type ParticleMeshBatch,
  type ParticleOutputBatch,
  validateParticleRenderBatch,
} from '../render-batch.js';
import type {
  LoadedParticleEffect,
  ParticleRuntimeEmitter,
  ParticleRuntimeProgram,
} from '../runtime-program.js';
import type { ParticleCpuExecutorRegistry } from './cpu-executor-registry.js';
import {
  createParticleSimulationOwner,
  resetParticleSimulationOwner,
  simulateParticleOwner,
  snapshotParticleOwner,
} from './simulate.js';
import type {
  ParticleSimulationAssets,
  ParticleSimulationEffect,
  ParticleSimulationEmitterStatus,
  ParticleSimulationError,
  ParticleSimulationObservation,
  ParticleSimulationOutputBatch,
  ParticleSimulationOwner,
  ParticleSimulationPlayerInput,
  ParticleSimulationResourceError,
  ParticleSimulationSnapshot,
} from './types.js';

export const PARTICLE_SIMULATION_RESOURCE_KEY = 'ParticleSimulation';

interface EmitterRuntime {
  readonly emitter: ParticleRuntimeEmitter;
  readonly owner: ParticleSimulationOwner | undefined;
  status: ParticleSimulationEmitterStatus;
  diagnostic: VfxError | undefined;
  output: ParticleOutputBatch | undefined;
}

interface PlayerRuntime {
  readonly player: EntityHandle;
  effect: Handle<'ParticleEffectAsset', 'shared'>;
  effectValue: ParticleSimulationEffect;
  seed: number;
  playing: boolean;
  timeScale: number;
  replayRequested: boolean;
  emitters: EmitterRuntime[];
  observation: ParticleSimulationObservation | undefined;
}

/** World-owned, transient particle state and public observation surface. */
export class ParticleSimulation {
  readonly #assets: ParticleSimulationAssets;
  readonly #cpuExecutors: ParticleCpuExecutorRegistry;
  readonly #players = new Map<number, PlayerRuntime>();

  constructor(assets: ParticleSimulationAssets, cpuExecutors: ParticleCpuExecutorRegistry) {
    this.#assets = assets;
    this.#cpuExecutors = cpuExecutors;
  }

  /** Read the last atomically committed observation for a live player. */
  read(player: EntityHandle): ParticleSimulationObservation | undefined {
    return this.#players.get(player)?.observation;
  }

  /** Request a tick-boundary replay from tick zero using the current seed. */
  replay(player: EntityHandle): Result<void, ParticleSimulationResourceError> {
    const runtime = this.#players.get(player);
    if (runtime === undefined) return err(missingPlayer(player));
    runtime.replayRequested = true;
    return ok(undefined);
  }

  /** Request the same reset boundary as replay; the alias keeps recovery explicit. */
  reset(player: EntityHandle): Result<void, ParticleSimulationResourceError> {
    return this.replay(player);
  }

  /** Reconcile all Player rows once from the owning World FixedUpdate system. */
  advance(world: World, players: readonly ParticleSimulationPlayerInput[]): void {
    const seen = new Set<number>();
    const fixed = world.getResource(FixedTime);
    for (const input of players) {
      seen.add(input.player);
      this.advancePlayer(world, fixed, input);
    }
    for (const [player, runtime] of this.#players) {
      if (!seen.has(player)) {
        releaseRuntimeOutputs(world, runtime.emitters);
        this.#players.delete(player);
      }
    }
  }

  private advancePlayer(
    world: World,
    fixed: FixedTimeResource,
    input: ParticleSimulationPlayerInput,
  ): void {
    const resolved = world.sharedRefs.resolve<'ParticleEffectAsset', ParticleSimulationEffect>(
      input.effect,
    );
    if (!resolved.ok) {
      const diagnostic = missingEffect(input.player, input.effect);
      const prior = this.#players.get(input.player);
      if (prior !== undefined) {
        prior.emitters.forEach((emitter) => {
          clearEmitterOutput(world, emitter);
          emitter.status = 'failed';
          emitter.diagnostic = diagnostic;
        });
        prior.effect = input.effect;
        prior.playing = input.playing;
        prior.seed = input.seed;
        prior.timeScale = input.timeScale;
        prior.observation = observationFor(prior, fixed.tick, [diagnostic]);
      }
      return;
    }

    let runtime = this.#players.get(input.player);
    const effectChanged = runtime === undefined || runtime.effect !== input.effect;
    const seedChanged = runtime !== undefined && runtime.seed !== input.seed;
    if (runtime === undefined || effectChanged || seedChanged || runtime.replayRequested) {
      if (runtime !== undefined) releaseRuntimeOutputs(world, runtime.emitters);
      runtime = createRuntime(input, resolved.value, this.#cpuExecutors);
      this.#players.set(input.player, runtime);
    }
    runtime.effect = input.effect;
    runtime.effectValue = resolved.value;
    runtime.seed = input.seed;
    runtime.playing = input.playing;
    runtime.timeScale = input.timeScale;
    runtime.replayRequested = false;

    const invalidTimeScale = !Number.isFinite(input.timeScale) || input.timeScale < 0;
    const diagnostics: VfxError[] = [];
    if (invalidTimeScale) {
      const diagnostic = invalidPlayer(input.player, input.timeScale);
      diagnostics.push(diagnostic);
      for (const emitter of runtime.emitters) {
        if (emitter.status !== 'disabled') {
          clearEmitterOutput(world, emitter);
          emitter.status = 'failed';
          emitter.diagnostic = diagnostic;
        }
      }
    } else {
      for (const emitter of runtime.emitters) {
        this.advanceEmitter(world, fixed, runtime, emitter, diagnostics);
      }
    }
    runtime.observation = observationFor(runtime, fixed.tick, diagnostics);
  }

  private advanceEmitter(
    world: World,
    fixed: FixedTimeResource,
    runtime: PlayerRuntime,
    emitter: EmitterRuntime,
    diagnostics: VfxError[],
  ): void {
    if (emitter.owner === undefined) {
      if (emitter.diagnostic !== undefined) diagnostics.push(emitter.diagnostic);
      return;
    }
    const result = simulateParticleOwner(emitter.owner, {
      fixedDelta: fixed.delta,
      tick: fixed.tick,
      playing: runtime.playing,
      seed: runtime.seed,
      timeScale: runtime.timeScale,
    });
    if (!result.ok) {
      emitter.status = 'failed';
      emitter.diagnostic = normalizeDiagnostic(result.error);
      diagnostics.push(emitter.diagnostic);
      return;
    }
    emitter.status = 'ready';
    emitter.diagnostic = undefined;
    const snapshot = snapshotParticleOwner(emitter.owner);
    const output = this.resolveOutput(world, runtime.player, emitter, snapshot);
    if (!output.ok) {
      clearEmitterOutput(world, emitter);
      emitter.status =
        output.error.code === 'vfx-simulation-output-unavailable' ? 'unavailable' : 'failed';
      emitter.diagnostic = output.error;
      diagnostics.push(output.error);
      return;
    }
    if (output.value === undefined) {
      if (emitter.output !== undefined) releaseOutput(world, emitter.output);
      emitter.output = undefined;
      return;
    }
    if (emitter.output !== undefined) releaseOutput(world, emitter.output);
    emitter.output = output.value;
  }

  private resolveOutput(
    world: World,
    player: EntityHandle,
    runtime: EmitterRuntime,
    snapshot: ParticleSimulationSnapshot,
  ): Result<ParticleSimulationOutputBatch | undefined, VfxError> {
    const emitterSnapshot = snapshot.emitters[0];
    if (emitterSnapshot === undefined || emitterSnapshot.liveCount === 0) return ok(undefined);
    const output = runtime.emitter.output;
    const material = this.#assets.lookup(output.material);
    if (!isAssetKind(material, 'material')) {
      return err(outputDiagnostic(player, runtime.emitter.id, output.material, 'material'));
    }
    const materialHandle = world.allocSharedRef('MaterialAsset', material);
    const count = emitterSnapshot.liveCount;
    if (output.kind === 'billboard') {
      const size = new Float32Array(count * 2);
      for (let index = 0; index < count; index += 1) {
        const value = emitterSnapshot.sizes[index] ?? 0;
        size[index * 2] = value;
        size[index * 2 + 1] = value;
      }
      const candidate = {
        kind: 'billboard' as const,
        material: materialHandle,
        count,
        attributes: {
          position: emitterSnapshot.positions.slice(0, count * 3),
          size,
          color: emitterSnapshot.colors.slice(0, count * 4),
        },
      };
      return validatedOutput(world, candidate);
    }
    const mesh = this.#assets.lookup(output.mesh);
    if (!isAssetKind(mesh, 'mesh')) {
      world.sharedRefs.release(materialHandle);
      return err(outputDiagnostic(player, runtime.emitter.id, output.mesh, 'mesh'));
    }
    const meshHandle = world.allocSharedRef('MeshAsset', mesh);
    const transform = new Float32Array(count * 16);
    for (let index = 0; index < count; index += 1) {
      const base = index * 16;
      transform[base] = 1;
      transform[base + 5] = 1;
      transform[base + 10] = 1;
      transform[base + 15] = 1;
      transform[base + 12] = emitterSnapshot.positions[index * 3] ?? 0;
      transform[base + 13] = emitterSnapshot.positions[index * 3 + 1] ?? 0;
      transform[base + 14] = emitterSnapshot.positions[index * 3 + 2] ?? 0;
    }
    const candidate: ParticleMeshBatch = {
      kind: 'mesh',
      material: materialHandle,
      mesh: meshHandle,
      count,
      attributes: {
        transform,
        color: emitterSnapshot.colors.slice(0, count * 4),
      },
    };
    return validatedOutput(world, candidate);
  }
}

function createRuntime(
  input: ParticleSimulationPlayerInput,
  effect: LoadedParticleEffect,
  registry: ParticleCpuExecutorRegistry,
): PlayerRuntime {
  const emitters = effect.program.emitters.map((emitter) =>
    createEmitterRuntime(input.player, input.seed, effect.program, emitter, registry),
  );
  const runtime: PlayerRuntime = {
    player: input.player,
    effect: input.effect,
    effectValue: effect,
    seed: input.seed,
    playing: input.playing,
    timeScale: input.timeScale,
    replayRequested: false,
    emitters,
    observation: undefined,
  };
  runtime.observation = observationFor(runtime, 0, []);
  return runtime;
}

function createEmitterRuntime(
  player: EntityHandle,
  seed: number,
  program: ParticleRuntimeProgram,
  emitter: ParticleRuntimeEmitter,
  registry: ParticleCpuExecutorRegistry,
): EmitterRuntime {
  const selectedStatus = backendStatus(emitter);
  const status =
    selectedStatus === 'ready' && emitter.programs.cpu === undefined
      ? 'unavailable'
      : selectedStatus;
  const owner =
    status === 'ready'
      ? createParticleSimulationOwner({
          player,
          seed,
          program: { format: program.format, emitters: [emitter] },
          registry,
        })
      : undefined;
  const diagnostic =
    status === 'disabled'
      ? undefined
      : status === 'unavailable'
        ? vfxError('vfx-simulation-capability-unavailable', {
            player,
            emitterId: emitter.id,
            stage: 'spawn',
            backend: 'gpu',
            plan: emitter.backendPlan.kind,
          })
        : undefined;
  return { emitter, owner, status, diagnostic, output: undefined };
}

function backendStatus(emitter: ParticleRuntimeEmitter): ParticleSimulationEmitterStatus {
  switch (emitter.backendPlan.kind) {
    case 'cpu':
    case 'gpu-with-cpu-fallback':
      return emitter.backendPlan.kind === 'gpu-with-cpu-fallback' &&
        !emitter.backendPlan.backends.includes('cpu')
        ? 'unavailable'
        : 'ready';
    case 'gpu-or-disable':
      return 'disabled';
    case 'gpu':
      return 'unavailable';
  }
}

function observationFor(
  runtime: PlayerRuntime,
  tick: number,
  extraDiagnostics: readonly VfxError[],
): ParticleSimulationObservation {
  const diagnostics = runtime.emitters
    .map((emitter) => emitter.diagnostic)
    .filter((diagnostic): diagnostic is VfxError => diagnostic !== undefined);
  diagnostics.push(...extraDiagnostics.filter((diagnostic) => !diagnostics.includes(diagnostic)));
  const batch = createParticleRenderBatch(
    runtime.emitters
      .map((emitter) => emitter.output)
      .filter((output): output is ParticleOutputBatch => output !== undefined),
  );
  return {
    player: runtime.player,
    effect: runtime.effect,
    seed: runtime.seed,
    playing: runtime.playing,
    timeScale: runtime.timeScale,
    tick,
    emitters: runtime.emitters.map((emitter) => ({
      emitterId: emitter.emitter.id,
      status: emitter.status,
      liveCount:
        emitter.owner === undefined
          ? 0
          : (snapshotParticleOwner(emitter.owner).emitters[0]?.liveCount ?? 0),
      capacity: emitter.emitter.capacity,
      overflowCount:
        emitter.owner === undefined
          ? 0
          : (snapshotParticleOwner(emitter.owner).emitters[0]?.overflowCount ?? 0),
    })),
    batches: batch.ok ? batch.value : { batches: [] },
    diagnostics: Object.freeze(diagnostics),
  };
}

function validatedOutput(
  world: World,
  candidate: ParticleOutputBatch,
): Result<ParticleSimulationOutputBatch, VfxError> {
  const result = validateParticleRenderBatch({ batches: [candidate] });
  if (!result.ok) {
    releaseOutput(world, candidate);
    return err(result.error);
  }
  const output = result.value.batches[0];
  if (output === undefined) {
    releaseOutput(world, candidate);
    return err(
      vfxError('vfx-batch-invalid', {
        output: candidate.kind,
        index: 0,
        path: 'batches[0]',
      }),
    );
  }
  return ok(output);
}

function releaseRuntimeOutputs(world: World, emitters: readonly EmitterRuntime[]): void {
  for (const emitter of emitters) {
    clearEmitterOutput(world, emitter);
    if (emitter.owner !== undefined) resetParticleSimulationOwner(emitter.owner);
  }
}

function clearEmitterOutput(world: World, emitter: EmitterRuntime): void {
  if (emitter.output !== undefined) releaseOutput(world, emitter.output);
  emitter.output = undefined;
}

function releaseOutput(world: World, output: ParticleOutputBatch): void {
  world.sharedRefs.release(output.material);
  if (output.kind === 'mesh') world.sharedRefs.release(output.mesh);
}

function isAssetKind(
  value: unknown,
  kind: 'material' | 'mesh',
): value is { readonly kind: typeof kind } {
  return typeof value === 'object' && value !== null && 'kind' in value && value.kind === kind;
}

function missingPlayer(player: EntityHandle): VfxError {
  return vfxError('vfx-simulation-player-invalid', {
    player,
    field: 'player',
    value: player,
  });
}

function missingEffect(
  player: EntityHandle,
  effect: Handle<'ParticleEffectAsset', 'shared'>,
): VfxError {
  return vfxError('vfx-simulation-player-invalid', {
    player,
    field: 'effect',
    value: effect,
  });
}

function invalidPlayer(player: EntityHandle, value: number): VfxError {
  return vfxError('vfx-simulation-player-invalid', {
    player,
    field: 'timeScale',
    value,
  });
}

function outputDiagnostic(
  player: EntityHandle,
  emitterId: string,
  reference: string,
  expectedKind: 'material' | 'mesh',
): VfxError {
  return vfxError('vfx-simulation-output-unavailable', {
    player,
    emitterId,
    stage: 'output',
    reference,
    expectedKind,
  });
}

function normalizeDiagnostic(error: ParticleSimulationError): VfxError {
  switch (error.code) {
    case 'vfx-simulation-player-invalid':
      return vfxError('vfx-simulation-player-invalid', {
        player: error.detail.player,
        field: error.detail.field ?? 'simulation',
        value: error.detail.value,
      });
    case 'vfx-simulation-capability-unavailable':
      return vfxError('vfx-simulation-capability-unavailable', {
        player: error.detail.player,
        emitterId: error.detail.emitterId,
        stage: error.detail.stage,
        backend: 'cpu',
        plan: 'cpu',
      });
    case 'vfx-simulation-execution-failed':
      return vfxError('vfx-simulation-execution-failed', {
        player: error.detail.player,
        emitterId: error.detail.emitterId,
        stage: error.detail.stage,
        operator: error.detail.operator,
        reason: error.detail.reason ?? 'executor rejected the particle state',
      });
  }
}

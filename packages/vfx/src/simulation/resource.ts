import type { EntityHandle, FixedTimeResource, World } from '@forgeax/engine-ecs';
import { FixedTime } from '@forgeax/engine-ecs';
import type { Handle, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { type VfxError, vfxError } from '../errors.js';
import {
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
  recordParticleSimulationAllocation,
  resetParticleSimulationOwner,
  simulateParticleOwner,
} from './simulate.js';
import {
  type ParticleSpacePose,
  type ParticleSpaceResolver,
  type ParticleSpaceResolverError,
  transformParticlePoint,
} from './space-resolver.js';
import type {
  ParticleSimulationAssets,
  ParticleSimulationEffect,
  ParticleSimulationEmitterObservation,
  ParticleSimulationEmitterStatus,
  ParticleSimulationError,
  ParticleSimulationObservation,
  ParticleSimulationOutputBatch,
  ParticleSimulationOwner,
  ParticleSimulationPlayerInput,
  ParticleSimulationResourceError,
  ParticleSimulationTelemetry,
} from './types.js';

export const PARTICLE_SIMULATION_RESOURCE_KEY = 'ParticleSimulation';

interface EmitterRuntime {
  readonly emitter: ParticleRuntimeEmitter;
  readonly owner: ParticleSimulationOwner | undefined;
  status: ParticleSimulationEmitterStatus;
  diagnostic: VfxError | undefined;
  output: ParticleOutputBatch | undefined;
  observation: MutableEmitterObservation;
  readonly tickInput: MutableParticleSimulationTickInput;
  spacePose: ParticleSpacePose | undefined;
  spaceError: ParticleSpaceResolverError | undefined;
}

type MutableParticleSimulationTickInput = {
  -readonly [Key in keyof import('./types.js').ParticleSimulationTickInput]: import('./types.js').ParticleSimulationTickInput[Key];
};

type MutableTelemetry = {
  -readonly [Key in keyof ParticleSimulationTelemetry]: ParticleSimulationTelemetry[Key];
};

type MutableEmitterObservation = {
  -readonly [Key in keyof ParticleSimulationEmitterObservation]: ParticleSimulationEmitterObservation[Key];
};

type MutableObservation = {
  -readonly [Key in keyof ParticleSimulationObservation]: ParticleSimulationObservation[Key];
} & {
  emitters: MutableEmitterObservation[];
  diagnostics: VfxError[];
  telemetry: MutableTelemetry;
  batchSpaces: import('./types.js').ParticleSimulationBatchSpace[];
  spaceDiagnostics: ParticleSpaceResolverError[];
};

interface PlayerRuntime {
  readonly player: EntityHandle;
  effect: Handle<'ParticleEffectAsset', 'shared'>;
  effectValue: ParticleSimulationEffect;
  seed: number;
  playing: boolean;
  timeScale: number;
  replayRequested: boolean;
  emitters: EmitterRuntime[];
  observation: MutableObservation;
  readonly diagnostics: VfxError[];
  readonly spaceDiagnostics: ParticleSpaceResolverError[];
}

/** World-owned, transient particle state and public observation surface. */
export class ParticleSimulation {
  readonly #assets: ParticleSimulationAssets;
  readonly #cpuExecutors: ParticleCpuExecutorRegistry;
  readonly #spaceResolver: ParticleSpaceResolver | undefined;
  readonly #players = new Map<number, PlayerRuntime>();
  readonly #seenPlayers = new Set<number>();

  constructor(
    assets: ParticleSimulationAssets,
    cpuExecutors: ParticleCpuExecutorRegistry,
    spaceResolver?: ParticleSpaceResolver,
  ) {
    this.#assets = assets;
    this.#cpuExecutors = cpuExecutors;
    this.#spaceResolver = spaceResolver;
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
    this.#seenPlayers.clear();
    const fixed = world.getResource(FixedTime);
    for (const input of players) {
      this.#seenPlayers.add(input.player);
      this.advancePlayer(world, fixed, input);
    }
    for (const [player, runtime] of this.#players) {
      if (!this.#seenPlayers.has(player)) {
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
        prior.effect = input.effect;
        prior.emitters.forEach((emitter) => {
          clearEmitterOutput(world, emitter);
          emitter.status = 'failed';
          emitter.diagnostic = diagnostic;
        });
        updateObservation(prior, fixed.tick, [diagnostic]);
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
    const diagnostics = runtime.diagnostics;
    diagnostics.length = 0;
    if (invalidTimeScale) {
      const diagnostic = invalidPlayer(input.player, input.timeScale);
      diagnostics.push(diagnostic);
      for (const emitter of runtime.emitters) {
        if (emitter.status !== 'disabled') {
          emitter.status = 'failed';
          emitter.diagnostic = diagnostic;
        }
      }
    } else {
      for (const emitter of runtime.emitters) {
        this.advanceEmitter(world, fixed, runtime, emitter, diagnostics);
      }
    }
    const spaceBlocked = runtime.emitters.some((emitter) => emitter.spaceError !== undefined);
    updateObservation(
      runtime,
      fixed.tick,
      diagnostics,
      !spaceBlocked && canCommitObservation(diagnostics),
    );
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
    if (emitter.emitter.space === 'world' && this.#spaceResolver !== undefined) {
      const resolved = this.#spaceResolver.resolve({
        player: runtime.player,
        space: 'world',
        phase: 'spawn',
        tick: fixed.tick,
      });
      if (!resolved.ok) {
        emitter.spacePose = undefined;
        emitter.spaceError = resolved.error;
        emitter.status =
          resolved.error.code === 'particle-space-parent-unavailable' ? 'unavailable' : 'failed';
        return;
      }
      emitter.spacePose = resolved.value;
      emitter.spaceError = undefined;
    }
    const tickInput = emitter.tickInput;
    tickInput.fixedDelta = fixed.delta;
    tickInput.tick = fixed.tick;
    tickInput.playing = runtime.playing;
    tickInput.seed = runtime.seed;
    tickInput.timeScale = runtime.timeScale;
    if (emitter.emitter.space === 'world' && emitter.spacePose !== undefined) {
      tickInput.space = { mode: 'world', pose: emitter.spacePose };
    } else {
      delete tickInput.space;
    }
    const result = simulateParticleOwner(emitter.owner, tickInput);
    if (!result.ok) {
      emitter.status = 'failed';
      emitter.diagnostic = normalizeDiagnostic(result.error);
      diagnostics.push(emitter.diagnostic);
      return;
    }
    emitter.status = 'ready';
    emitter.diagnostic = undefined;
    const state = emitter.owner.emitterStates[0];
    if (state !== undefined && emitter.spacePose !== undefined) {
      bakeWorldSpawnPositions(state, emitter.spacePose);
    }
    const output = this.resolveOutput(world, runtime.player, emitter, state);
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
    emitter.output = output.value;
  }

  private resolveOutput(
    world: World,
    player: EntityHandle,
    runtime: EmitterRuntime,
    state: ParticleSimulationOwner['emitterStates'][number] | undefined,
  ): Result<ParticleSimulationOutputBatch | undefined, VfxError> {
    if (state === undefined || state.liveCount === 0) return ok(undefined);
    const output = runtime.emitter.output;
    const material = this.#assets.lookup(output.material);
    if (!isAssetKind(material, 'material')) {
      return err(outputDiagnostic(player, runtime.emitter.id, output.material, 'material'));
    }
    const count = state.liveCount;
    const existing = runtime.output;
    if (existing !== undefined && existing.kind === output.kind) {
      if (existing.kind === 'billboard') {
        const target = existing as {
          count: number;
          attributes: { position: Float32Array; size: Float32Array; color: Float32Array };
        };
        const attributes = target.attributes;
        if (attributes.position.length !== count * 3) {
          attributes.position = allocateFloat32(runtime.owner, count * 3);
          attributes.size = allocateFloat32(runtime.owner, count * 2);
          attributes.color = allocateFloat32(runtime.owner, count * 4);
        }
        writeBillboardAttributes(attributes, state, count);
        target.count = count;
        return ok(existing);
      }
      const target = existing as {
        count: number;
        attributes: { transform: Float32Array; color: Float32Array };
      };
      if (target.attributes.transform.length !== count * 16) {
        target.attributes.transform = allocateFloat32(runtime.owner, count * 16);
        target.attributes.color = allocateFloat32(runtime.owner, count * 4);
      }
      writeMeshAttributes(target.attributes, state, count);
      target.count = count;
      return ok(existing);
    }
    const materialHandle = world.allocSharedRef('MaterialAsset', material);
    if (output.kind === 'billboard') {
      const candidate = {
        kind: 'billboard' as const,
        material: materialHandle,
        count,
        attributes: {
          position: new Float32Array(count * 3),
          size: new Float32Array(count * 2),
          color: new Float32Array(count * 4),
        },
      };
      writeBillboardAttributes(candidate.attributes, state, count);
      const validated = validatedOutput(world, candidate);
      if (validated.ok && existing !== undefined) releaseOutput(world, existing);
      return validated;
    }
    const mesh = this.#assets.lookup(output.mesh);
    if (!isAssetKind(mesh, 'mesh')) {
      world.sharedRefs.release(materialHandle);
      return err(outputDiagnostic(player, runtime.emitter.id, output.mesh, 'mesh'));
    }
    const meshHandle = world.allocSharedRef('MeshAsset', mesh);
    const candidate: ParticleMeshBatch = {
      kind: 'mesh',
      material: materialHandle,
      mesh: meshHandle,
      count,
      attributes: {
        transform: new Float32Array(count * 16),
        color: new Float32Array(count * 4),
      },
    };
    writeMeshAttributes(candidate.attributes, state, count);
    const validated = validatedOutput(world, candidate);
    if (validated.ok && existing !== undefined) releaseOutput(world, existing);
    return validated;
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
    observation: undefined as unknown as MutableObservation,
    diagnostics: [],
    spaceDiagnostics: [],
  };
  runtime.observation = createObservation(runtime);
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
  return {
    emitter,
    owner,
    status,
    diagnostic,
    output: undefined,
    tickInput: { fixedDelta: 0, tick: 0, playing: true, seed, timeScale: 1 },
    spacePose: undefined,
    spaceError: undefined,
    observation: {
      emitterId: emitter.id,
      status,
      liveCount: 0,
      capacity: emitter.capacity,
      overflowCount: 0,
      spawned: 0,
      dropped: 0,
    },
  };
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

function createObservation(runtime: PlayerRuntime): MutableObservation {
  const telemetry: MutableTelemetry = {
    tick: 0,
    alive: 0,
    spawned: 0,
    dropped: 0,
    selectedBackend: 'none',
    cpuUpdateMs: 0,
    allocatedBytes: 0,
  };
  const observation = {
    player: runtime.player,
    effect: runtime.effect,
    seed: runtime.seed,
    playing: runtime.playing,
    timeScale: runtime.timeScale,
    tick: 0,
    emitters: runtime.emitters.map((emitter) => emitter.observation),
    batches: { batches: [] as ParticleOutputBatch[] },
    diagnostics: runtime.diagnostics,
    telemetry,
    batchSpaces: [],
    spaceDiagnostics: runtime.spaceDiagnostics,
  } as MutableObservation;
  runtime.observation = observation;
  updateObservation(runtime, 0, []);
  return observation;
}

function updateObservation(
  runtime: PlayerRuntime,
  tick: number,
  extraDiagnostics: readonly VfxError[],
  commit = true,
): void {
  const observation = runtime.observation;
  const diagnostics = runtime.diagnostics;
  diagnostics.length = 0;
  for (const emitter of runtime.emitters) {
    if (emitter.diagnostic !== undefined) diagnostics.push(emitter.diagnostic);
    const state = emitter.owner?.emitterStates[0];
    const emitterObservation = emitter.observation as MutableEmitterObservation;
    emitterObservation.status = emitter.status;
    emitterObservation.liveCount = state?.liveCount ?? 0;
    emitterObservation.overflowCount = state?.overflowCount ?? 0;
    emitterObservation.spawned = state?.spawnedCount ?? 0;
    emitterObservation.dropped = state?.droppedCount ?? 0;
  }
  for (const diagnostic of extraDiagnostics) {
    if (!diagnostics.includes(diagnostic)) diagnostics.push(diagnostic);
  }
  const spaceDiagnostics = observation.spaceDiagnostics ?? [];
  observation.spaceDiagnostics = spaceDiagnostics;
  spaceDiagnostics.length = 0;
  for (const emitter of runtime.emitters) {
    if (emitter.spaceError !== undefined) spaceDiagnostics.push(emitter.spaceError);
  }
  if (!commit) return;
  const batches = observation.batches.batches as ParticleOutputBatch[];
  const batchSpaces = observation.batchSpaces ?? [];
  observation.batchSpaces = batchSpaces;
  let batchCount = 0;
  let alive = 0;
  let spawned = 0;
  let dropped = 0;
  let cpuUpdateMs = 0;
  let allocatedBytes = 0;
  let hasGpu = false;
  let hasCpu = false;
  for (const emitter of runtime.emitters) {
    if (emitter.output !== undefined) {
      batches[batchCount] = emitter.output;
      const pose = emitter.spacePose;
      batchSpaces[batchCount] = {
        emitterId: emitter.emitter.id,
        space: emitter.emitter.space,
        source: pose?.source ?? 'root',
        ...(pose?.parent === undefined ? {} : { parent: pose.parent }),
        ...(pose?.joint === undefined ? {} : { joint: pose.joint }),
      };
      batchCount += 1;
    }
    const state = emitter.owner?.emitterStates[0];
    alive += state?.liveCount ?? 0;
    spawned += state?.spawnedCount ?? 0;
    dropped += state?.droppedCount ?? 0;
    cpuUpdateMs += emitter.owner?.cpuUpdateMs ?? 0;
    allocatedBytes += emitter.owner?.allocatedBytes ?? 0;
    hasCpu ||= emitter.status === 'ready';
    hasGpu ||= emitter.emitter.backendPlan.kind !== 'cpu';
  }
  batches.length = batchCount;
  batchSpaces.length = batchCount;
  observation.player = runtime.player;
  observation.effect = runtime.effect;
  observation.seed = runtime.seed;
  observation.playing = runtime.playing;
  observation.timeScale = runtime.timeScale;
  observation.tick = tick;
  const telemetry = observation.telemetry as MutableTelemetry;
  telemetry.tick = tick;
  telemetry.alive = alive;
  telemetry.spawned = spawned;
  telemetry.dropped = dropped;
  telemetry.selectedBackend = hasCpu ? 'cpu' : hasGpu ? 'gpu' : 'none';
  telemetry.cpuUpdateMs = cpuUpdateMs;
  telemetry.allocatedBytes = allocatedBytes;
}

function bakeWorldSpawnPositions(
  state: ParticleSimulationOwner['emitterStates'][number],
  pose: ParticleSpacePose,
): void {
  for (let index = 0; index < state.spawnedCount; index += 1) {
    const slot = state.spawnedSlots[index] ?? 0;
    transformParticlePoint(pose.matrix, state.positions, slot * 3, state.positions, slot * 3);
  }
}

function writeBillboardAttributes(
  attributes: { position: Float32Array; size: Float32Array; color: Float32Array },
  state: ParticleSimulationOwner['emitterStates'][number],
  count: number,
): void {
  for (let index = 0; index < count * 3; index += 1) {
    attributes.position[index] = state.positions[index] ?? 0;
  }
  for (let index = 0; index < count * 4; index += 1) {
    attributes.color[index] = state.colors[index] ?? 0;
  }
  for (let index = 0; index < count; index += 1) {
    const size = state.sizes[index] ?? 0;
    attributes.size[index * 2] = size;
    attributes.size[index * 2 + 1] = size;
  }
}

function writeMeshAttributes(
  attributes: { transform: Float32Array; color: Float32Array },
  state: ParticleSimulationOwner['emitterStates'][number],
  count: number,
): void {
  for (let index = 0; index < count * 4; index += 1) {
    attributes.color[index] = state.colors[index] ?? 0;
  }
  for (let index = 0; index < count; index += 1) {
    const base = index * 16;
    attributes.transform.fill(0, base, base + 16);
    attributes.transform[base] = 1;
    attributes.transform[base + 5] = 1;
    attributes.transform[base + 10] = 1;
    attributes.transform[base + 15] = 1;
    attributes.transform[base + 12] = state.positions[index * 3] ?? 0;
    attributes.transform[base + 13] = state.positions[index * 3 + 1] ?? 0;
    attributes.transform[base + 14] = state.positions[index * 3 + 2] ?? 0;
  }
}

function allocateFloat32(owner: ParticleSimulationOwner | undefined, length: number): Float32Array {
  const array = new Float32Array(length);
  if (owner !== undefined) recordParticleSimulationAllocation(owner, array.byteLength);
  return array;
}

function canCommitObservation(diagnostics: readonly VfxError[]): boolean {
  return (
    diagnostics.length === 0 ||
    diagnostics.every((diagnostic) => diagnostic.code === 'vfx-simulation-output-unavailable')
  );
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

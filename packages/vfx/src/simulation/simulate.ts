import { type VfxError, vfxError } from '../errors.js';
import type { ParticleRuntimeEmitter } from '../runtime-program.js';
import {
  clearParticleEmitterState,
  cloneParticleEmitterState,
  compactDeadParticleSlots,
  createParticleEmitterState,
  initializeParticleSlot,
  particleContext,
  writeParticleContext,
} from './state.js';
import type {
  ParticleCpuExecutorContext,
  ParticleCpuExecutorResult,
  ParticleCpuOutputContext,
  ParticleCpuRandomStream,
  ParticleCpuVector,
  ParticleSimulationEmitterSnapshot,
  ParticleSimulationEmitterState,
  ParticleSimulationError,
  ParticleSimulationOwner,
  ParticleSimulationOwnerOptions,
  ParticleSimulationSnapshot,
  ParticleSimulationTickInput,
} from './types.js';

class OwnerRandomStream implements ParticleCpuRandomStream {
  drawIndex: number;

  constructor(
    private readonly seed: number,
    drawIndex: number,
  ) {
    this.drawIndex = drawIndex;
  }

  nextUint32(): number {
    const index = this.drawIndex;
    this.drawIndex += 1;
    let value = (this.seed + Math.imul(index, 0x9e3779b9)) >>> 0;
    value ^= value >>> 16;
    value = Math.imul(value, 0x85ebca6b) >>> 0;
    value ^= value >>> 13;
    value = Math.imul(value, 0xc2b2ae35) >>> 0;
    return (value ^ (value >>> 16)) >>> 0;
  }

  nextFloat(): number {
    return this.nextUint32() / 0x100000000;
  }
}

export function createParticleSimulationOwner(
  options: ParticleSimulationOwnerOptions,
): ParticleSimulationOwner {
  return {
    player: options.player,
    program: options.program,
    registry: options.registry,
    emitterStates: options.program.emitters.map(createParticleEmitterState),
    seed: options.seed >>> 0,
    tick: 0,
    drawIndex: 0,
    nextBirthOrder: 0,
  };
}

export function resetParticleSimulationOwner(owner: ParticleSimulationOwner): void {
  for (const state of owner.emitterStates) clearParticleEmitterState(state);
  owner.tick = 0;
  owner.drawIndex = 0;
  owner.nextBirthOrder = 0;
  delete owner.lastFailure;
}

export function simulateParticleOwner(
  owner: ParticleSimulationOwner,
  input: ParticleSimulationTickInput,
): ParticleCpuExecutorResult<void, ParticleSimulationError> {
  const timeScale = input.timeScale ?? 1;
  if (!Number.isFinite(timeScale) || timeScale < 0) {
    return failure(owner.player, 'timeScale', timeScale);
  }
  if (!Number.isFinite(input.fixedDelta) || input.fixedDelta < 0) {
    return failure(owner.player, 'fixedDelta', input.fixedDelta);
  }

  const seedChanged = input.seed !== undefined && input.seed >>> 0 !== owner.seed;
  const reset = input.reset === true || seedChanged;
  if (input.fixedDelta === 0) return { ok: true, value: undefined };
  if (reset) {
    for (const state of owner.emitterStates) clearParticleEmitterState(state);
    owner.seed = (input.seed ?? owner.seed) >>> 0;
    owner.drawIndex = 0;
    owner.nextBirthOrder = 0;
  }
  if (input.playing === false) {
    if (reset) owner.tick = 0;
    return { ok: true, value: undefined };
  }

  const working = owner.emitterStates.map(cloneParticleEmitterState);
  const random = new OwnerRandomStream(owner.seed, owner.drawIndex);
  const delta = input.fixedDelta * timeScale;
  let nextBirthOrder = owner.nextBirthOrder;

  for (const emitter of owner.program.emitters) {
    const state = working.find((candidate) => candidate.emitterId === emitter.id);
    if (state === undefined) {
      return failExecution(owner, emitter.id, 'spawn', 'program', 'emitter state is missing');
    }
    const complete = owner.registry.checkProgram(owner.program, emitter.id, owner.player);
    if (!complete.ok) return failExecutionWithError(owner, complete.error);
    const result = simulateEmitter(
      owner,
      emitter,
      state,
      delta,
      input.tick,
      random,
      nextBirthOrder,
    );
    if (!result.ok) return result;
    nextBirthOrder = result.value.nextBirthOrder;
  }

  for (let index = 0; index < working.length; index += 1) {
    const next = working[index];
    const current = owner.emitterStates[index];
    if (next === undefined || current === undefined) continue;
    commitEmitterState(current, next);
    current.drawIndex = random.drawIndex;
  }
  owner.drawIndex = random.drawIndex;
  owner.nextBirthOrder = nextBirthOrder;
  owner.tick = input.tick;
  delete owner.lastFailure;
  return { ok: true, value: undefined };
}

export function snapshotParticleOwner(owner: ParticleSimulationOwner): ParticleSimulationSnapshot {
  const emitters = owner.emitterStates.map(snapshotEmitter);
  const batches = emitters
    .filter((emitter) => emitter.liveCount > 0)
    .map((emitter) => ({
      emitterId: emitter.emitterId,
      count: emitter.liveCount,
      positions: emitter.positions,
      sizes: emitter.sizes,
      colors: emitter.colors,
    }));
  return {
    tick: owner.tick,
    drawIndex: owner.drawIndex,
    emitters,
    batches,
    bytes: bytesOf(emitters),
  };
}

function simulateEmitter(
  owner: ParticleSimulationOwner,
  emitter: ParticleRuntimeEmitter,
  state: ParticleSimulationEmitterState,
  delta: number,
  tick: number,
  random: OwnerRandomStream,
  nextBirthOrder: number,
): ParticleCpuExecutorResult<{ readonly nextBirthOrder: number }, ParticleSimulationError> {
  const previousElapsed = state.elapsed;
  const nextElapsed = previousElapsed + delta;
  const scheduled = emitter.schedule.rate * delta + state.emissionRemainder;
  const rateSpawns = Math.floor(scheduled);
  state.emissionRemainder = scheduled - rateSpawns;
  const burstSpawns = (emitter.schedule.bursts ?? []).reduce(
    (count, burst) =>
      count + (burst.time > previousElapsed && burst.time <= nextElapsed ? burst.count : 0),
    0,
  );
  const spawnAttempts = rateSpawns + burstSpawns;
  state.elapsed = nextElapsed;
  const available = state.capacity - state.liveCount;
  const accepted = Math.min(available, spawnAttempts);
  state.overflowCount += spawnAttempts - accepted;
  const spawnedSlots: number[] = [];

  for (let index = 0; index < accepted; index += 1) {
    const slot = state.liveCount;
    initializeParticleSlot(state, slot, nextBirthOrder + index);
    state.liveCount += 1;
    spawnedSlots.push(slot);
  }
  const birthOrder = nextBirthOrder + accepted;

  const spawnResult = runStage(owner, emitter, state, 'spawn', spawnedSlots, delta, tick, random);
  if (!spawnResult.ok) return spawnResult;
  const initializeResult = runStage(
    owner,
    emitter,
    state,
    'initialize',
    spawnedSlots,
    delta,
    tick,
    random,
  );
  if (!initializeResult.ok) return initializeResult;

  const liveSlots = Array.from({ length: state.liveCount }, (_, index) => index);
  const updateResult = runStage(owner, emitter, state, 'update', liveSlots, delta, tick, random);
  if (!updateResult.ok) return updateResult;
  for (const slot of liveSlots) {
    const age = (state.ages[slot] ?? 0) + delta;
    const lifetime = state.lifetimes[slot] ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(age) || lifetime < 0 || Number.isNaN(lifetime)) {
      return failExecution(
        owner,
        emitter.id,
        'update',
        'lifetime',
        'numeric particle state is invalid',
      );
    }
    state.ages[slot] = age;
    state.active[slot] = age >= lifetime ? 0 : 1;
  }
  compactDeadParticleSlots(state);
  const outputSlots = Array.from({ length: state.liveCount }, (_, index) => index);
  const outputResult = runStage(owner, emitter, state, 'output', outputSlots, delta, tick, random);
  if (!outputResult.ok) return outputResult;
  return { ok: true, value: { nextBirthOrder: birthOrder } };
}

function runStage(
  owner: ParticleSimulationOwner,
  emitter: ParticleRuntimeEmitter,
  state: ParticleSimulationEmitterState,
  stage: 'spawn' | 'initialize' | 'update' | 'output',
  slots: readonly number[],
  delta: number,
  tick: number,
  random: OwnerRandomStream,
): ParticleCpuExecutorResult<void, ParticleSimulationError> {
  const programs =
    emitter.programs.cpu?.filter((program) => program.operator.startsWith(`${stage}:`)) ?? [];
  for (const slot of slots) {
    for (const stageProgram of programs) {
      const resolved = owner.registry.resolveProgram(stageProgram, owner.player, emitter.id);
      if (!resolved.ok) return failExecutionWithError(owner, resolved.error);
      const particle = particleContext(state, slot);
      const output: ParticleCpuOutputContext = {
        position: particle.position.slice() as ParticleCpuVector,
        size: particle.size,
        color: particle.color.slice() as ParticleCpuVector,
      };
      const context = {
        stage,
        operator: stageProgram.operator,
        emitterId: emitter.id,
        tick,
        delta,
        program: stageProgram.program,
        random,
        particle,
        output,
        ...(stage === 'spawn' ? { spawnIndex: slot } : {}),
      } as ParticleCpuExecutorContext;
      const executed = resolved.value.execute(context);
      if (!executed.ok) {
        return failExecution(owner, emitter.id, stage, stageProgram.operator, executed.error);
      }
      if (stage === 'output') particle.position.set(output.position);
      particle.size = output.size;
      particle.color.set(output.color);
      writeParticleContext(state, particle);
    }
  }
  return { ok: true, value: undefined };
}

function snapshotEmitter(state: ParticleSimulationEmitterState): ParticleSimulationEmitterSnapshot {
  const count = state.liveCount;
  return {
    emitterId: state.emitterId,
    liveCount: count,
    capacity: state.capacity,
    ages: state.ages.slice(0, count),
    lifetimes: state.lifetimes.slice(0, count),
    birthOrders: state.birthOrders.slice(0, count),
    positions: state.positions.slice(0, count * 3),
    velocities: state.velocities.slice(0, count * 3),
    sizes: state.sizes.slice(0, count),
    colors: state.colors.slice(0, count * 4),
    overflowCount: state.overflowCount,
    emissionRemainder: state.emissionRemainder,
  };
}

function commitEmitterState(
  target: ParticleSimulationEmitterState,
  source: ParticleSimulationEmitterState,
): void {
  target.active.set(source.active);
  target.birthOrders.set(source.birthOrders);
  target.ages.set(source.ages);
  target.lifetimes.set(source.lifetimes);
  target.positions.set(source.positions);
  target.velocities.set(source.velocities);
  target.sizes.set(source.sizes);
  target.colors.set(source.colors);
  target.liveCount = source.liveCount;
  target.emissionRemainder = source.emissionRemainder;
  target.elapsed = source.elapsed;
  target.overflowCount = source.overflowCount;
}

function bytesOf(emitters: readonly ParticleSimulationEmitterSnapshot[]): Uint8Array {
  const arrays = emitters.flatMap((emitter) => [
    emitter.birthOrders,
    emitter.ages,
    emitter.lifetimes,
    emitter.positions,
    emitter.velocities,
    emitter.sizes,
    emitter.colors,
  ]);
  const bytes = arrays.map(
    (array) => new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
  );
  const result = new Uint8Array(bytes.reduce((length, value) => length + value.byteLength, 0));
  let offset = 0;
  for (const value of bytes) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

function failure(
  player: number,
  field: string,
  value: unknown,
): ParticleCpuExecutorResult<never, ParticleSimulationError> {
  return {
    ok: false,
    error: {
      ...vfxError('vfx-simulation-player-invalid', { player, field, value }),
      detail: {
        player,
        emitterId: '',
        stage: 'spawn',
        operator: field,
        field,
        value,
        reason: 'invalid player input',
      },
    },
  };
}

function failExecution(
  owner: ParticleSimulationOwner,
  emitterId: string,
  stage: 'spawn' | 'initialize' | 'update' | 'output',
  operator: string,
  reason: string,
): ParticleCpuExecutorResult<never, ParticleSimulationError> {
  const error = vfxError('vfx-simulation-execution-failed', {
    player: owner.player,
    emitterId,
    stage,
    operator,
    reason,
  });
  return { ok: false, error: { ...error, detail: { ...error.detail } } };
}

function failExecutionWithError(
  owner: ParticleSimulationOwner,
  error: VfxError,
): ParticleCpuExecutorResult<never, ParticleSimulationError> {
  owner.lastFailure = error;
  const detail = error.detail as Partial<ParticleSimulationError['detail']>;
  return {
    ok: false,
    error: {
      code: error.code as ParticleSimulationError['code'],
      expected: error.expected,
      hint: error.hint,
      detail: {
        player: detail.player ?? owner.player,
        emitterId: detail.emitterId ?? '',
        stage: detail.stage ?? 'spawn',
        operator: detail.operator ?? 'program',
        ...(detail.field === undefined ? {} : { field: detail.field }),
        ...(detail.value === undefined ? {} : { value: detail.value }),
        ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      },
    },
  };
}

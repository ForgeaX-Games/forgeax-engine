import { type VfxError, vfxError } from '../errors.js';
import type { ParticleRuntimeEmitter } from '../runtime-program.js';
import {
  advanceParticleAgesAndReap,
  clearParticleEmitterState,
  compactDeadParticleSlots,
  copyParticleEmitterState,
  createParticleEmitterState,
  initializeParticleSlot,
  particleContext,
  writeParticleContext,
} from './state.js';
import type {
  ParticleCpuExecutorContext,
  ParticleCpuExecutorResult,
  ParticleCpuRandomStream,
  ParticleSimulationEmitterSnapshot,
  ParticleSimulationEmitterState,
  ParticleSimulationError,
  ParticleSimulationOwner,
  ParticleSimulationOwnerOptions,
  ParticleSimulationSnapshot,
  ParticleSimulationTickInput,
} from './types.js';

const SUCCESS_RESULT: ParticleCpuExecutorResult<void, ParticleSimulationError> = {
  ok: true,
  value: undefined,
};

class OwnerRandomStream implements ParticleCpuRandomStream {
  drawIndex: number;
  private seed: number;

  constructor(seed: number, drawIndex: number) {
    this.seed = seed;
    this.drawIndex = drawIndex;
  }

  reset(seed: number, drawIndex: number): void {
    this.seed = seed;
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
  const owner: ParticleSimulationOwner = {
    player: options.player,
    program: options.program,
    registry: options.registry,
    random: new OwnerRandomStream(options.seed >>> 0, 0),
    emitterStates: options.program.emitters.map(createParticleEmitterState),
    scratchEmitterStates: options.program.emitters.map(createParticleEmitterState),
    seed: options.seed >>> 0,
    tick: 0,
    drawIndex: 0,
    nextBirthOrder: 0,
    cpuUpdateMs: 0,
    allocatedBytes: 0,
  };
  return owner;
}

export function resetParticleSimulationOwner(owner: ParticleSimulationOwner): void {
  for (const state of owner.emitterStates) clearParticleEmitterState(state);
  for (const state of owner.scratchEmitterStates) clearParticleEmitterState(state);
  owner.tick = 0;
  owner.drawIndex = 0;
  owner.nextBirthOrder = 0;
  owner.cpuUpdateMs = 0;
  owner.allocatedBytes = 0;
  delete owner.lastFailure;
}

/** Attribute explicit VFX-owned storage allocation to the current tick. */
export function recordParticleSimulationAllocation(
  owner: ParticleSimulationOwner,
  bytes: number,
): void {
  if (bytes > 0 && Number.isFinite(bytes)) owner.allocatedBytes += Math.trunc(bytes);
}

export function simulateParticleOwner(
  owner: ParticleSimulationOwner,
  input: ParticleSimulationTickInput,
): ParticleCpuExecutorResult<void, ParticleSimulationError> {
  owner.allocatedBytes = 0;
  const timeScale = input.timeScale ?? 1;
  if (!Number.isFinite(timeScale) || timeScale < 0) {
    return failure(owner.player, 'timeScale', timeScale);
  }
  if (!Number.isFinite(input.fixedDelta) || input.fixedDelta < 0) {
    return failure(owner.player, 'fixedDelta', input.fixedDelta);
  }

  const seedChanged = input.seed !== undefined && input.seed >>> 0 !== owner.seed;
  const reset = input.reset === true || seedChanged;
  if (input.fixedDelta === 0) return SUCCESS_RESULT;
  if (reset) {
    for (const state of owner.emitterStates) clearParticleEmitterState(state);
    for (const state of owner.scratchEmitterStates) clearParticleEmitterState(state);
    owner.seed = (input.seed ?? owner.seed) >>> 0;
    owner.drawIndex = 0;
    owner.nextBirthOrder = 0;
  }
  if (input.playing === false) {
    if (reset) owner.tick = 0;
    return { ok: true, value: undefined };
  }

  const working = owner.scratchEmitterStates;
  for (let index = 0; index < owner.emitterStates.length; index += 1) {
    const committed = owner.emitterStates[index];
    const scratch = working[index];
    if (committed === undefined || scratch === undefined) continue;
    copyParticleEmitterState(scratch, committed);
  }
  const random = owner.random as OwnerRandomStream;
  random.reset(owner.seed, owner.drawIndex);
  const startedAt = globalThis.performance?.now() ?? 0;
  const delta = input.fixedDelta * timeScale;
  let nextBirthOrder = owner.nextBirthOrder;

  for (let emitterIndex = 0; emitterIndex < owner.program.emitters.length; emitterIndex += 1) {
    const emitter = owner.program.emitters[emitterIndex];
    const state = working[emitterIndex];
    if (emitter === undefined || state === undefined) {
      return failExecution(
        owner,
        emitter?.id ?? '',
        'spawn',
        'program',
        'emitter state is missing',
      );
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
    if (typeof result !== 'number') return { ok: false, error: result };
    nextBirthOrder = result;
  }

  for (let index = 0; index < working.length; index += 1) {
    const next = working[index];
    const current = owner.emitterStates[index];
    if (next === undefined || current === undefined) continue;
    owner.emitterStates[index] = next;
    owner.scratchEmitterStates[index] = current;
    next.drawIndex = random.drawIndex;
  }
  owner.drawIndex = random.drawIndex;
  owner.nextBirthOrder = nextBirthOrder;
  owner.tick = input.tick;
  owner.cpuUpdateMs = Math.max(0, (globalThis.performance?.now() ?? startedAt) - startedAt);
  delete owner.lastFailure;
  return SUCCESS_RESULT;
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
): number | ParticleSimulationError {
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
  state.spawnedCount = accepted;
  state.droppedCount = spawnAttempts - accepted;
  const spawnedSlots = state.spawnedSlots;
  let spawnedCount = 0;

  for (let index = 0; index < accepted; index += 1) {
    const slot = state.liveCount;
    initializeParticleSlot(state, slot, nextBirthOrder + index);
    state.liveCount += 1;
    spawnedSlots[spawnedCount] = slot;
    spawnedCount += 1;
  }
  const birthOrder = nextBirthOrder + accepted;

  const spawnResult = runStage(
    owner,
    emitter,
    state,
    'spawn',
    spawnedSlots,
    spawnedCount,
    delta,
    tick,
    random,
  );
  if (spawnResult !== undefined) return spawnResult;
  const initializeResult = runStage(
    owner,
    emitter,
    state,
    'initialize',
    spawnedSlots,
    spawnedCount,
    delta,
    tick,
    random,
  );
  if (initializeResult !== undefined) return initializeResult;

  const liveSlots = state.liveSlots;
  for (let index = 0; index < state.liveCount; index += 1) liveSlots[index] = index;
  const updateResult = runStage(
    owner,
    emitter,
    state,
    'update',
    liveSlots,
    state.liveCount,
    delta,
    tick,
    random,
  );
  if (updateResult !== undefined) return updateResult;
  const ageResult = advanceParticleAgesAndReap(state, liveSlots, delta, state.liveCount);
  if (!ageResult.ok) {
    return failureError(failExecution(owner, emitter.id, 'update', 'lifetime', ageResult.error));
  }
  compactDeadParticleSlots(state);
  const outputSlots = state.outputSlots;
  for (let index = 0; index < state.liveCount; index += 1) outputSlots[index] = index;
  const outputResult = runStage(
    owner,
    emitter,
    state,
    'output',
    outputSlots,
    state.liveCount,
    delta,
    tick,
    random,
  );
  if (outputResult !== undefined) return outputResult;
  return birthOrder;
}

function runStage(
  owner: ParticleSimulationOwner,
  emitter: ParticleRuntimeEmitter,
  state: ParticleSimulationEmitterState,
  stage: 'spawn' | 'initialize' | 'update' | 'output',
  slots: Uint32Array,
  slotCount: number,
  delta: number,
  tick: number,
  random: OwnerRandomStream,
): ParticleSimulationError | undefined {
  const programs = emitter.programs.cpu;
  if (programs === undefined) return undefined;
  for (let slotIndex = 0; slotIndex < slotCount; slotIndex += 1) {
    const slot = slots[slotIndex] ?? 0;
    for (const stageProgram of programs) {
      if (!stageProgram.operator.startsWith(`${stage}:`)) continue;
      const resolved = owner.registry.resolveProgram(stageProgram, owner.player, emitter.id);
      if (!resolved.ok) return failureError(failExecutionWithError(owner, resolved.error));
      const particle = particleContext(state, slot);
      const output = state.output;
      output.position.set(particle.position);
      output.size = particle.size;
      output.color.set(particle.color);
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
        return failureError(
          failExecution(owner, emitter.id, stage, stageProgram.operator, executed.error),
        );
      }
      if (stage === 'output') {
        particle.position.set(output.position);
        particle.size = output.size;
        particle.color.set(output.color);
      }
      writeParticleContext(state, particle);
    }
  }
  return undefined;
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

function failureError(
  result: ParticleCpuExecutorResult<never, ParticleSimulationError>,
): ParticleSimulationError {
  if (!result.ok) return result.error;
  throw new Error('simulation failure helper returned success');
}

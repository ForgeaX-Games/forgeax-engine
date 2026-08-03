import type { ParticleRuntimeEmitter } from '../runtime-program.js';
import type {
  ParticleCpuOutputContext,
  ParticleCpuParticleContext,
  ParticleCpuVector,
  ParticleSimulationEmitterState,
} from './types.js';

const DEFAULT_COLOR = [1, 1, 1, 1] as const;

export function createParticleEmitterState(
  emitter: ParticleRuntimeEmitter,
): ParticleSimulationEmitterState {
  const state: ParticleSimulationEmitterState = {
    emitterId: emitter.id,
    capacity: emitter.capacity,
    active: new Uint8Array(emitter.capacity),
    birthOrders: new Uint32Array(emitter.capacity),
    ages: new Float32Array(emitter.capacity),
    lifetimes: new Float32Array(emitter.capacity),
    positions: new Float32Array(emitter.capacity * 3),
    velocities: new Float32Array(emitter.capacity * 3),
    sizes: new Float32Array(emitter.capacity),
    colors: new Float32Array(emitter.capacity * 4),
    liveCount: 0,
    emissionRemainder: 0,
    elapsed: 0,
    overflowCount: 0,
    drawIndex: 0,
    spawnedCount: 0,
    droppedCount: 0,
    spawnedSlots: new Uint32Array(emitter.capacity),
    liveSlots: new Uint32Array(emitter.capacity),
    outputSlots: new Uint32Array(emitter.capacity),
    particle: createParticleContext(),
    output: createOutputContext(),
  };
  return state;
}

export function cloneParticleEmitterState(
  source: ParticleSimulationEmitterState,
): ParticleSimulationEmitterState {
  return {
    emitterId: source.emitterId,
    capacity: source.capacity,
    active: source.active.slice(),
    birthOrders: source.birthOrders.slice(),
    ages: source.ages.slice(),
    lifetimes: source.lifetimes.slice(),
    positions: source.positions.slice(),
    velocities: source.velocities.slice(),
    sizes: source.sizes.slice(),
    colors: source.colors.slice(),
    liveCount: source.liveCount,
    emissionRemainder: source.emissionRemainder,
    elapsed: source.elapsed,
    overflowCount: source.overflowCount,
    drawIndex: source.drawIndex,
    spawnedCount: source.spawnedCount,
    droppedCount: source.droppedCount,
    spawnedSlots: source.spawnedSlots.slice(),
    liveSlots: source.liveSlots.slice(),
    outputSlots: source.outputSlots.slice(),
    particle: createParticleContext(),
    output: createOutputContext(),
  };
}

export function copyParticleEmitterState(
  target: ParticleSimulationEmitterState,
  source: ParticleSimulationEmitterState,
): void {
  const count = source.liveCount;
  target.active.set(source.active.subarray(0, count), 0);
  target.active[count] = 0;
  target.birthOrders.set(source.birthOrders.subarray(0, count), 0);
  target.ages.set(source.ages.subarray(0, count), 0);
  target.lifetimes.set(source.lifetimes.subarray(0, count), 0);
  target.positions.set(source.positions.subarray(0, count * 3), 0);
  target.velocities.set(source.velocities.subarray(0, count * 3), 0);
  target.sizes.set(source.sizes.subarray(0, count), 0);
  target.colors.set(source.colors.subarray(0, count * 4), 0);
  target.liveCount = count;
  target.emissionRemainder = source.emissionRemainder;
  target.elapsed = source.elapsed;
  target.overflowCount = source.overflowCount;
  target.drawIndex = source.drawIndex;
  target.spawnedCount = source.spawnedCount;
  target.droppedCount = source.droppedCount;
}

export function clearParticleEmitterState(state: ParticleSimulationEmitterState): void {
  state.active.fill(0);
  state.birthOrders.fill(0);
  state.ages.fill(0);
  state.lifetimes.fill(0);
  state.positions.fill(0);
  state.velocities.fill(0);
  state.sizes.fill(0);
  state.colors.fill(0);
  state.liveCount = 0;
  state.emissionRemainder = 0;
  state.elapsed = 0;
  state.overflowCount = 0;
  state.drawIndex = 0;
  state.spawnedCount = 0;
  state.droppedCount = 0;
  state.particle.position.fill(0);
  state.particle.velocity.fill(0);
  state.particle.color.fill(0);
  state.output.position.fill(0);
  state.output.color.fill(0);
}

export function particleContext(
  state: ParticleSimulationEmitterState,
  slot: number,
): ParticleCpuParticleContext {
  const positionStart = slot * 3;
  const colorStart = slot * 4;
  state.particle.slot = slot;
  state.particle.birthOrder = state.birthOrders[slot] ?? 0;
  state.particle.age = state.ages[slot] ?? 0;
  state.particle.lifetime = state.lifetimes[slot] ?? 0;
  state.particle.position.set(state.positions.subarray(positionStart, positionStart + 3));
  state.particle.velocity.set(state.velocities.subarray(positionStart, positionStart + 3));
  state.particle.size = state.sizes[slot] ?? 0;
  state.particle.color.set(state.colors.subarray(colorStart, colorStart + 4));
  return state.particle;
}

export function writeParticleContext(
  state: ParticleSimulationEmitterState,
  particle: ParticleCpuParticleContext,
): void {
  const positionStart = particle.slot * 3;
  const colorStart = particle.slot * 4;
  state.birthOrders[particle.slot] = particle.birthOrder;
  state.ages[particle.slot] = particle.age;
  state.lifetimes[particle.slot] = particle.lifetime;
  state.positions.set(particle.position, positionStart);
  state.velocities.set(particle.velocity, positionStart);
  state.sizes[particle.slot] = particle.size;
  state.colors.set(particle.color, colorStart);
}

export function initializeParticleSlot(
  state: ParticleSimulationEmitterState,
  slot: number,
  birthOrder: number,
): void {
  state.birthOrders[slot] = birthOrder;
  const particle = particleContext(state, slot);
  particle.age = 0;
  particle.lifetime = Number.POSITIVE_INFINITY;
  particle.position.fill(0);
  particle.velocity.fill(0);
  particle.size = 1;
  particle.color.set(DEFAULT_COLOR);
  writeParticleContext(state, particle);
  state.active[slot] = 1;
}

export type ParticleAgeAdvanceResult =
  | { readonly ok: true; readonly value: undefined }
  | { readonly ok: false; readonly error: 'numeric particle state is invalid' };

/** Advance age and mark expired slots before compaction and output. */
export function advanceParticleAgesAndReap(
  state: ParticleSimulationEmitterState,
  slots: ArrayLike<number>,
  delta: number,
  slotCount = slots.length,
): ParticleAgeAdvanceResult {
  for (let index = 0; index < slotCount; index += 1) {
    const slot = slots[index] ?? 0;
    const age = (state.ages[slot] ?? 0) + delta;
    const lifetime = state.lifetimes[slot] ?? Number.POSITIVE_INFINITY;
    if (!Number.isFinite(age) || lifetime < 0 || Number.isNaN(lifetime)) {
      return { ok: false, error: 'numeric particle state is invalid' };
    }
    state.ages[slot] = age;
    state.active[slot] = age >= lifetime ? 0 : 1;
  }
  return { ok: true, value: undefined };
}

export function compactDeadParticleSlots(state: ParticleSimulationEmitterState): void {
  let writeSlot = 0;
  for (let readSlot = 0; readSlot < state.liveCount; readSlot += 1) {
    if (state.active[readSlot] === 0) continue;
    if (writeSlot !== readSlot) copySlot(state, readSlot, writeSlot);
    state.active[writeSlot] = 1;
    writeSlot += 1;
  }
  state.active[writeSlot] = 0;
  state.liveCount = writeSlot;
}

function createParticleContext(): ParticleCpuParticleContext {
  return {
    slot: 0,
    birthOrder: 0,
    age: 0,
    lifetime: 0,
    position: new Float32Array(3) as ParticleCpuVector,
    velocity: new Float32Array(3) as ParticleCpuVector,
    size: 0,
    color: new Float32Array(4) as ParticleCpuVector,
  };
}

function createOutputContext(): ParticleCpuOutputContext {
  return {
    position: new Float32Array(3) as ParticleCpuVector,
    size: 0,
    color: new Float32Array(4) as ParticleCpuVector,
  };
}

function copySlot(state: ParticleSimulationEmitterState, source: number, target: number): void {
  state.birthOrders[target] = state.birthOrders[source] ?? 0;
  state.ages[target] = state.ages[source] ?? 0;
  state.lifetimes[target] = state.lifetimes[source] ?? 0;
  state.sizes[target] = state.sizes[source] ?? 0;
  state.positions.set(state.positions.subarray(source * 3, source * 3 + 3), target * 3);
  state.velocities.set(state.velocities.subarray(source * 3, source * 3 + 3), target * 3);
  state.colors.set(state.colors.subarray(source * 4, source * 4 + 4), target * 4);
}

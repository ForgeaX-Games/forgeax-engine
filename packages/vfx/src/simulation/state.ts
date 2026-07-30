import type { ParticleRuntimeEmitter } from '../runtime-program.js';
import type {
  ParticleCpuParticleContext,
  ParticleCpuVector,
  ParticleSimulationEmitterState,
} from './types.js';

const DEFAULT_COLOR = [1, 1, 1, 1] as const;

export function createParticleEmitterState(
  emitter: ParticleRuntimeEmitter,
): ParticleSimulationEmitterState {
  return {
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
  };
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
  };
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
}

export function particleContext(
  state: ParticleSimulationEmitterState,
  slot: number,
): ParticleCpuParticleContext {
  const positionStart = slot * 3;
  const colorStart = slot * 4;
  return {
    slot,
    birthOrder: state.birthOrders[slot] ?? 0,
    age: state.ages[slot] ?? 0,
    lifetime: state.lifetimes[slot] ?? 0,
    position: state.positions.slice(positionStart, positionStart + 3) as ParticleCpuVector,
    velocity: state.velocities.slice(positionStart, positionStart + 3) as ParticleCpuVector,
    size: state.sizes[slot] ?? 0,
    color: state.colors.slice(colorStart, colorStart + 4) as ParticleCpuVector,
  };
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

export function compactDeadParticleSlots(state: ParticleSimulationEmitterState): void {
  let writeSlot = 0;
  for (let readSlot = 0; readSlot < state.liveCount; readSlot += 1) {
    if (state.active[readSlot] === 0) continue;
    if (writeSlot !== readSlot) copySlot(state, readSlot, writeSlot);
    state.active[writeSlot] = 1;
    writeSlot += 1;
  }
  state.active.fill(0, writeSlot);
  state.liveCount = writeSlot;
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

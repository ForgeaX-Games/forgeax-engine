import type { EntityHandle, World } from '@forgeax/engine-ecs';
import type { Handle, ParticleEffectAsset } from '@forgeax/engine-types';
import type { VfxError } from '../errors.js';
import type { ParticleOutputBatch, ParticleRenderBatch } from '../render-batch.js';
import type { ParticleRuntimeProgram } from '../runtime-program.js';
import type { ParticleOperatorStage } from '../source.js';

export type ParticleCpuExecutorStage = ParticleOperatorStage;

export type ParticleCpuExecutorResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export interface ParticleCpuRandomStream {
  readonly drawIndex: number;
  nextUint32(): number;
  nextFloat(): number;
}

export type ParticleCpuVector = Float32Array & {
  0: number;
  1: number;
  2: number;
  3: number;
};

export interface ParticleCpuParticleContext {
  readonly slot: number;
  readonly birthOrder: number;
  age: number;
  lifetime: number;
  readonly position: ParticleCpuVector;
  readonly velocity: ParticleCpuVector;
  size: number;
  readonly color: ParticleCpuVector;
}

export interface ParticleCpuOutputContext {
  position: ParticleCpuVector;
  size: number;
  color: ParticleCpuVector;
}

export interface ParticleCpuExecutorContextBase {
  readonly stage: ParticleCpuExecutorStage;
  readonly operator: string;
  readonly emitterId: string;
  readonly tick: number;
  readonly delta: number;
  readonly program: unknown;
  readonly random: ParticleCpuRandomStream;
  readonly particle: ParticleCpuParticleContext;
  readonly output: ParticleCpuOutputContext;
}

export interface ParticleCpuSpawnContext extends ParticleCpuExecutorContextBase {
  readonly stage: 'spawn';
  readonly spawnIndex: number;
}

export interface ParticleCpuInitializeContext extends ParticleCpuExecutorContextBase {
  readonly stage: 'initialize';
}

export interface ParticleCpuUpdateContext extends ParticleCpuExecutorContextBase {
  readonly stage: 'update';
}

export interface ParticleCpuOutputStageContext extends ParticleCpuExecutorContextBase {
  readonly stage: 'output';
}

export type ParticleCpuExecutorContext =
  | ParticleCpuSpawnContext
  | ParticleCpuInitializeContext
  | ParticleCpuUpdateContext
  | ParticleCpuOutputStageContext;

export interface ParticleSimulationErrorDetail {
  readonly player: number;
  readonly emitterId: string;
  readonly stage: ParticleCpuExecutorStage;
  readonly operator: string;
  readonly field?: string;
  readonly value?: unknown;
  readonly reason?: string;
}

export interface ParticleSimulationError {
  readonly code:
    | 'vfx-simulation-player-invalid'
    | 'vfx-simulation-capability-unavailable'
    | 'vfx-simulation-execution-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: ParticleSimulationErrorDetail;
}

export type ParticleCpuExecutorError = VfxError;

export interface ParticleSimulationEmitterState {
  readonly emitterId: string;
  readonly capacity: number;
  readonly active: Uint8Array;
  readonly birthOrders: Uint32Array;
  readonly ages: Float32Array;
  readonly lifetimes: Float32Array;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  readonly sizes: Float32Array;
  readonly colors: Float32Array;
  liveCount: number;
  emissionRemainder: number;
  elapsed: number;
  overflowCount: number;
  drawIndex: number;
}

export interface ParticleSimulationOwnerOptions {
  readonly player: number;
  readonly seed: number;
  readonly program: ParticleRuntimeProgram;
  readonly registry: import('./cpu-executor-registry.js').ParticleCpuExecutorRegistry;
}

export interface ParticleSimulationOwner {
  readonly player: number;
  readonly program: ParticleRuntimeProgram;
  readonly registry: import('./cpu-executor-registry.js').ParticleCpuExecutorRegistry;
  readonly emitterStates: ParticleSimulationEmitterState[];
  seed: number;
  tick: number;
  drawIndex: number;
  nextBirthOrder: number;
  lastFailure?: ParticleCpuExecutorError;
}

export interface ParticleSimulationTickInput {
  readonly fixedDelta: number;
  readonly tick: number;
  readonly playing?: boolean;
  readonly seed?: number;
  readonly timeScale?: number;
  readonly reset?: boolean;
}

export interface ParticleSimulationEmitterSnapshot {
  readonly emitterId: string;
  readonly liveCount: number;
  readonly capacity: number;
  readonly ages: Float32Array;
  readonly lifetimes: Float32Array;
  readonly birthOrders: Uint32Array;
  readonly positions: Float32Array;
  readonly velocities: Float32Array;
  readonly sizes: Float32Array;
  readonly colors: Float32Array;
  readonly overflowCount: number;
  readonly emissionRemainder: number;
}

export interface ParticleSimulationOutputSnapshot {
  readonly emitterId: string;
  readonly count: number;
  readonly positions: Float32Array;
  readonly sizes: Float32Array;
  readonly colors: Float32Array;
}

export interface ParticleSimulationSnapshot {
  readonly tick: number;
  readonly drawIndex: number;
  readonly emitters: readonly ParticleSimulationEmitterSnapshot[];
  readonly batches: readonly ParticleSimulationOutputSnapshot[];
  readonly bytes: Uint8Array;
}

/** Host-owned readiness lookup consumed synchronously by FixedUpdate. */
export interface ParticleSimulationAssets {
  lookup(guid: string): unknown;
}

/** Public per-emitter state label; capability failures never become empty. */
export type ParticleSimulationEmitterStatus = 'ready' | 'disabled' | 'unavailable' | 'failed';

/** Stable state visible for one emitter in a player observation. */
export interface ParticleSimulationEmitterObservation {
  readonly emitterId: string;
  readonly status: ParticleSimulationEmitterStatus;
  readonly liveCount: number;
  readonly capacity: number;
  readonly overflowCount: number;
}

/** Normalized player row supplied by the single FixedUpdate system. */
export interface ParticleSimulationPlayerInput {
  readonly player: EntityHandle;
  readonly effect: Handle<'ParticleEffectAsset', 'shared'>;
  readonly playing: boolean;
  readonly seed: number;
  readonly timeScale: number;
}

/** Public observation for one ParticleEffectPlayer. */
export interface ParticleSimulationObservation {
  readonly player: EntityHandle;
  readonly effect: Handle<'ParticleEffectAsset', 'shared'>;
  readonly seed: number;
  readonly playing: boolean;
  readonly timeScale: number;
  readonly tick: number;
  readonly emitters: readonly ParticleSimulationEmitterObservation[];
  readonly batches: ParticleRenderBatch;
  readonly diagnostics: readonly VfxError[];
}

export type ParticleSimulationResourceError = VfxError;

export type ParticleSimulationWorld = World;

export type ParticleSimulationOutputBatch = ParticleOutputBatch;

export type ParticleSimulationEffect = ParticleEffectAsset & {
  readonly program: ParticleRuntimeProgram;
};

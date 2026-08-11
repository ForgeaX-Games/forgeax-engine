import {
  Entity,
  type EntityHandle,
  err,
  FixedTime,
  FixedUpdate,
  ok,
  type World,
} from '@forgeax/engine-ecs';
import { type Plugin, PluginError } from '@forgeax/engine-plugin';
import { type Handle, toShared } from '@forgeax/engine-types';
import type { ParticleEventSource } from './code-source.js';
import type { VfxValueMap } from './effect-contract.js';
import { createVfxEffectContract, type VfxEffectReflection } from './effect-contract.js';
import type { VfxGpuEffectAsset, VfxGpuEmitterProgram } from './gpu-program.js';
import {
  ParticleEffectInstance,
  type VfxChannelCounters,
  type VfxReplayInput,
} from './instance.js';
import { ParticleEffectPlayer } from './player.js';

export const VFX_GPU_RUNTIME_RESOURCE_KEY = 'VfxGpuRuntime';

export interface VfxInspectSnapshotInput {
  readonly layoutFingerprint: string;
  readonly parameterGeneration: number;
  readonly patchCount: number;
  readonly dataInterfaces?: unknown;
  readonly channels?: unknown;
  readonly stages?: unknown;
  readonly renderers?: unknown;
  readonly hmr?: unknown;
  readonly gpuTiming?: unknown;
  readonly error?: {
    readonly code: string;
    readonly expected: string;
    readonly hint: string;
    readonly detail: unknown;
  };
}

export function createVfxInspectSnapshot(input: VfxInspectSnapshotInput) {
  return {
    layout: { fingerprint: input.layoutFingerprint },
    values: { generation: input.parameterGeneration, patchCount: input.patchCount },
    ...(input.dataInterfaces === undefined ? {} : { dataInterfaces: input.dataInterfaces }),
    ...(input.channels === undefined ? {} : { channels: input.channels }),
    ...(input.stages === undefined ? {} : { stages: input.stages }),
    ...(input.renderers === undefined ? {} : { renderers: input.renderers }),
    ...(input.hmr === undefined ? {} : { hmr: input.hmr }),
    ...(input.gpuTiming === undefined ? {} : { gpuTiming: input.gpuTiming }),
    ...(input.error === undefined ? {} : { error: input.error }),
  } as const;
}

export interface VfxGpuTickIntent {
  readonly sequence: number;
  readonly player: EntityHandle;
  readonly emitter: VfxGpuEmitterProgram;
  readonly programFingerprint: string;
  readonly reset: boolean;
  readonly fixedDelta: number;
  /** Effect-relative fixed tick. Resets to zero for replay and restart-on-visible. */
  readonly phaseTick: number;
  /** World-global FixedTime tick retained for renderer ring selection and correlation. */
  readonly tick: number;
  readonly seed: number;
  readonly playCycle: number;
  readonly spawnCount: number;
  readonly firstParticleId: number;
  readonly instanceGeneration: number;
  readonly instancePatchCount: number;
  readonly parameterBlock: Uint8Array;
  readonly canonicalPayload: Uint8Array;
  readonly replayInput: VfxReplayInput<VfxValueMap>;
  readonly channelInputs: VfxReplayInput<VfxValueMap>['channelInputs'];
  readonly eventCounters: VfxChannelCounters;
}

export interface VfxGpuEmitterInspectSnapshot {
  readonly id: string;
  readonly module: string;
  readonly capacity: number;
  /** Renderer-owned camera-frustum result. This is not an editor mute/isolate control. */
  readonly cameraVisible: boolean;
  /** Session-only preview mask. False suppresses both simulation and retained rendering. */
  readonly sessionEnabled: boolean;
  readonly phaseTick: number | null;
  readonly tick: number | null;
  readonly spawnCount: number;
  readonly firstParticleId: number;
  readonly reset: boolean;
  readonly schedule: VfxGpuEmitterProgram['schedule'];
  readonly bounds: VfxGpuEmitterProgram['bounds'];
  readonly simulationWhenCulled: VfxGpuEmitterProgram['simulationWhenCulled'];
  readonly renderers: readonly {
    readonly index: number;
    readonly kind: VfxGpuEmitterProgram['renderers'][number]['kind'];
    readonly enabled: boolean;
  }[];
  readonly stages: readonly string[];
  readonly dataInterfaces: readonly string[];
}

export interface VfxGpuPlayerInspectSnapshot {
  readonly player: EntityHandle;
  readonly assetGuid: string;
  readonly programFingerprint: string;
  readonly playing: boolean;
  readonly values: {
    readonly layoutFingerprint: string;
    readonly generation: number;
    readonly pendingPatchCount: number;
  };
  readonly channels: VfxChannelCounters;
  readonly emitters: readonly VfxGpuEmitterInspectSnapshot[];
  readonly diagnostics: readonly VfxGpuRuntimeDiagnostic[];
}

export interface VfxGpuRuntimeDiagnostic {
  readonly code:
    | 'vfx-intent-queue-overflow'
    | 'vfx-effect-unavailable'
    | 'vfx-player-invalid'
    | 'vfx-instance-commit-failed';
  readonly expected: string;
  readonly hint: string;
  readonly detail: { readonly player: EntityHandle; readonly maxQueuedTicks?: number };
}

interface PlayerState {
  effect: Handle<'ParticleEffectAsset', 'shared'>;
  assetGuid: string;
  programFingerprint: string;
  emitters: readonly VfxGpuEmitterProgram[];
  seed: number;
  playing: boolean;
  playCycle: number;
  elapsed: number[];
  rateRemainders: number[];
  nextParticleIds: number[];
  playCycles: number[];
  cameraVisible: boolean[];
  phaseTicks: number[];
  hasCommitted: boolean;
}

function eventCounters(
  intent: Pick<VfxGpuTickIntent, 'channelInputs' | 'emitter'>,
  dropped: number,
  eventSources: readonly ParticleEventSource[],
): VfxChannelCounters {
  const inputs = intent.channelInputs;
  const events = [...(intent.emitter.events ?? []), ...eventSources];
  return Object.freeze({
    queued: inputs.length,
    produced: (intent.emitter.events?.length ?? 0) > 0 ? inputs.length : 0,
    consumed:
      eventSources.length > 0
        ? inputs.length * eventSources.reduce((total, event) => total + event.fanOut, 0)
        : 0,
    dropped,
    overflow: dropped > 0 ? 1 : 0,
    fanOut: events.reduce((total, event) => total + event.fanOut, 0),
    recursionDepth: events.reduce((depth, event) => Math.max(depth, event.recursionDepth), 0),
    lastSequence: inputs.at(-1)?.sequence ?? -1,
  });
}

export interface VfxGpuRuntimeOptions {
  readonly maxQueuedTicks?: number;
}

export class VfxGpuRuntime {
  readonly #maxQueuedTicks: number;
  readonly #players = new Map<EntityHandle, PlayerState>();
  readonly #instances = new Map<EntityHandle, ParticleEffectInstance>();
  readonly #seen = new Set<EntityHandle>();
  readonly #intents: VfxGpuTickIntent[] = [];
  readonly #diagnostics: VfxGpuRuntimeDiagnostic[] = [];
  readonly #lastCommitted = new Map<EntityHandle, VfxGpuTickIntent>();
  readonly #lastCommittedByEmitter = new Map<EntityHandle, Map<string, VfxGpuTickIntent>>();
  readonly #eventCounters = new Map<EntityHandle, VfxChannelCounters>();
  readonly #cameraVisibility = new Map<string, boolean>();
  readonly #sessionEnabled = new Map<string, boolean>();
  readonly #replayRequests = new Set<EntityHandle>();
  readonly #replayInputs = new Map<EntityHandle, VfxReplayInput<VfxValueMap>>();
  #sequence = 0;

  constructor(options: VfxGpuRuntimeOptions = {}) {
    this.#maxQueuedTicks = options.maxQueuedTicks ?? 8;
  }

  snapshot(): readonly VfxGpuTickIntent[] {
    return this.#intents;
  }

  diagnostics(): readonly VfxGpuRuntimeDiagnostic[] {
    return this.#diagnostics;
  }

  lastCommitted(player: EntityHandle): VfxGpuTickIntent | undefined {
    return this.#lastCommitted.get(player);
  }

  inspectPlayers(): readonly VfxGpuPlayerInspectSnapshot[] {
    return Object.freeze(
      [...this.#players.keys()]
        .sort((left, right) => Number(left) - Number(right))
        .flatMap((player) => {
          const snapshot = this.inspectPlayer(player);
          return snapshot === undefined ? [] : [snapshot];
        }),
    );
  }

  inspectPlayer(player: EntityHandle): VfxGpuPlayerInspectSnapshot | undefined {
    const state = this.#players.get(player);
    if (state === undefined) return undefined;
    const instance = this.#instances.get(player);
    const latest = state.emitters.map((emitter) => this.#latestIntent(player, emitter.id));
    const lastIntent = latest.reduce<VfxGpuTickIntent | undefined>(
      (current, intent) =>
        intent !== undefined && (current === undefined || intent.sequence > current.sequence)
          ? intent
          : current,
      undefined,
    );
    const layoutFingerprint =
      state.emitters.find((emitter) => emitter.reflection.layout !== undefined)?.reflection.layout
        ?.fingerprint ?? state.programFingerprint;
    return Object.freeze({
      player,
      assetGuid: state.assetGuid,
      programFingerprint: state.programFingerprint,
      playing: state.playing,
      values: Object.freeze({
        layoutFingerprint,
        generation: instance?.generation ?? lastIntent?.instanceGeneration ?? 0,
        pendingPatchCount: instance?.pendingPatchCount ?? 0,
      }),
      channels: this.eventCounters(player),
      emitters: Object.freeze(
        state.emitters.map((emitter, index) => {
          const intent = latest[index];
          return Object.freeze({
            id: emitter.id,
            module: emitter.module,
            capacity: emitter.capacity,
            cameraVisible: this.#cameraVisibility.get(`${player}:${emitter.id}`) ?? true,
            sessionEnabled: this.isEmitterSessionEnabled(player, emitter.id),
            phaseTick: intent?.phaseTick ?? null,
            tick: intent?.tick ?? null,
            spawnCount: intent?.spawnCount ?? 0,
            firstParticleId: intent?.firstParticleId ?? 0,
            reset: intent?.reset ?? false,
            schedule: emitter.schedule,
            bounds: emitter.bounds,
            simulationWhenCulled: emitter.simulationWhenCulled,
            renderers: Object.freeze(
              emitter.renderers.map((renderer, rendererIndex) =>
                Object.freeze({
                  index: rendererIndex,
                  kind: renderer.kind,
                  enabled: renderer.enabled ?? true,
                }),
              ),
            ),
            stages: Object.freeze((emitter.reflection.stages ?? []).map((stage) => stage.id)),
            dataInterfaces: Object.freeze(
              (emitter.reflection.dataInterfaces ?? []).map((requirement) => requirement.token),
            ),
          });
        }),
      ),
      diagnostics: Object.freeze(
        this.#diagnostics.filter((diagnostic) => diagnostic.detail.player === player),
      ),
    });
  }

  eventCounters(player: EntityHandle): VfxChannelCounters {
    return (
      this.#eventCounters.get(player) ??
      this.#lastCommitted.get(player)?.eventCounters ?? {
        queued: 0,
        produced: 0,
        consumed: 0,
        dropped: 0,
        overflow: 0,
        fanOut: 0,
        recursionDepth: 0,
        lastSequence: -1,
      }
    );
  }

  markEventDispatched(player: EntityHandle, counters: VfxChannelCounters): void {
    const prior = this.#eventCounters.get(player);
    if (counters.produced === 0 && prior !== undefined) {
      this.#eventCounters.set(
        player,
        Object.freeze({
          ...prior,
          queued: 0,
          consumed: Math.max(prior.consumed, counters.consumed),
        }),
      );
      return;
    }
    this.#eventCounters.set(
      player,
      Object.freeze({ ...counters, queued: 0, consumed: counters.produced }),
    );
  }

  hasPlayer(player: EntityHandle): boolean {
    return this.#players.has(player);
  }

  attachInstance(player: EntityHandle, instance: ParticleEffectInstance): void {
    this.#instances.set(player, instance);
  }

  detachInstance(player: EntityHandle): void {
    this.#instances.delete(player);
  }

  getInstance(player: EntityHandle): ParticleEffectInstance | undefined {
    return this.#instances.get(player);
  }

  setEmitterCameraVisibility(player: EntityHandle, emitterId: string, visible: boolean): void {
    this.#cameraVisibility.set(`${player}:${emitterId}`, visible);
  }

  setEmitterSessionEnabled(player: EntityHandle, emitterId: string, enabled: boolean): void {
    this.#sessionEnabled.set(`${player}:${emitterId}`, enabled);
  }

  isEmitterSessionEnabled(player: EntityHandle, emitterId: string): boolean {
    return this.#sessionEnabled.get(`${player}:${emitterId}`) ?? true;
  }

  /** Restart from tick zero without changing authored `ParticleEffectPlayer.playing`. */
  replay(player: EntityHandle, input?: VfxReplayInput<VfxValueMap>): void {
    if (input === undefined) {
      this.#instances.delete(player);
    } else {
      this.#replayInputs.set(player, input);
    }
    this.#replayRequests.add(player);
  }

  commit(sequence: number): void {
    const committedPlayers = new Set<EntityHandle>();
    for (const intent of this.#intents) {
      if (intent.sequence > sequence) break;
      const state = this.#players.get(intent.player);
      if (state !== undefined) state.hasCommitted = true;
      this.#lastCommitted.set(intent.player, intent);
      let emitters = this.#lastCommittedByEmitter.get(intent.player);
      if (emitters === undefined) {
        emitters = new Map();
        this.#lastCommittedByEmitter.set(intent.player, emitters);
      }
      emitters.set(intent.emitter.id, intent);
      committedPlayers.add(intent.player);
    }
    const retained = this.#intents.findIndex((intent) => intent.sequence > sequence);
    if (retained < 0) this.#intents.length = 0;
    else if (retained > 0) this.#intents.splice(0, retained);
    for (const player of committedPlayers) {
      this.#clearDiagnostics(player, 'vfx-intent-queue-overflow');
    }
  }

  reset(player: EntityHandle): void {
    this.#players.delete(player);
    this.#instances.delete(player);
    this.#replayRequests.delete(player);
    this.#lastCommitted.delete(player);
    this.#lastCommittedByEmitter.delete(player);
    this.#eventCounters.delete(player);
    this.#replayInputs.delete(player);
    const prefix = `${player}:`;
    for (const key of this.#cameraVisibility.keys()) {
      if (key.startsWith(prefix)) this.#cameraVisibility.delete(key);
    }
    for (const key of this.#sessionEnabled.keys()) {
      if (key.startsWith(prefix)) this.#sessionEnabled.delete(key);
    }
  }

  #report(diagnostic: VfxGpuRuntimeDiagnostic): void {
    const prior = this.#diagnostics.at(-1);
    if (prior?.code === diagnostic.code && prior.detail.player === diagnostic.detail.player) return;
    if (this.#diagnostics.length === 64) this.#diagnostics.shift();
    this.#diagnostics.push(diagnostic);
  }

  #clearDiagnostics(player: EntityHandle, code?: VfxGpuRuntimeDiagnostic['code']): void {
    for (let index = this.#diagnostics.length - 1; index >= 0; index -= 1) {
      const diagnostic = this.#diagnostics[index];
      if (
        diagnostic?.detail.player === player &&
        (code === undefined || diagnostic.code === code)
      ) {
        this.#diagnostics.splice(index, 1);
      }
    }
  }

  advance(
    world: World,
    tick: number,
    fixedDelta: number,
    players: readonly {
      readonly player: EntityHandle;
      readonly effect: Handle<'ParticleEffectAsset', 'shared'>;
      readonly playing: boolean;
      readonly seed: number;
      readonly timeScale: number;
    }[],
  ): void {
    this.#seen.clear();
    for (const input of players) {
      this.#seen.add(input.player);
      if (!Number.isFinite(input.timeScale) || input.timeScale < 0) {
        this.#report({
          code: 'vfx-player-invalid',
          expected: 'a finite non-negative particle timeScale',
          hint: 'repair ParticleEffectPlayer.timeScale and restart the player',
          detail: { player: input.player },
        });
        continue;
      }
      this.#clearDiagnostics(input.player, 'vfx-player-invalid');
      const resolved = world.sharedRefs.resolve<'ParticleEffectAsset', VfxGpuEffectAsset>(
        input.effect,
      );
      if (!resolved.ok || resolved.value.schemaVersion !== 2) {
        this.#report({
          code: 'vfx-effect-unavailable',
          expected: 'a loaded schemaVersion 2 GPU particle effect',
          hint: 'load and recook the effect before the first FixedUpdate',
          detail: { player: input.player },
        });
        continue;
      }
      this.#clearDiagnostics(input.player, 'vfx-effect-unavailable');
      const previous = this.#players.get(input.player);
      const replayRequested = this.#replayRequests.delete(input.player);
      const restart =
        previous === undefined ||
        previous.effect !== input.effect ||
        previous.seed !== input.seed ||
        replayRequested ||
        (!previous.playing && input.playing);
      const state = restart
        ? {
            effect: input.effect,
            assetGuid: resolved.value.guid,
            programFingerprint: resolved.value.program.fingerprint,
            emitters: resolved.value.program.emitters,
            seed: input.seed,
            playing: input.playing,
            playCycle: (previous?.playCycle ?? -1) + 1,
            elapsed: resolved.value.program.emitters.map(() => 0),
            rateRemainders: resolved.value.program.emitters.map(() => 0),
            nextParticleIds: resolved.value.program.emitters.map(() => 0),
            playCycles: resolved.value.program.emitters.map(() => (previous?.playCycle ?? -1) + 1),
            cameraVisible: resolved.value.program.emitters.map(() => true),
            phaseTicks: resolved.value.program.emitters.map(() => 0),
            hasCommitted: false,
          }
        : previous;
      this.#players.set(input.player, state);
      // Replay is a one-FixedUpdate request, not a second persistent play-state
      // authority. Inspection always returns the authored player state after
      // the requested reset intent has been emitted.
      state.playing = input.playing;
      if (!input.playing && !replayRequested) continue;
      const queuedForPlayer = this.#intents.reduce(
        (count, intent) => count + (intent.player === input.player ? 1 : 0),
        0,
      );
      if (
        queuedForPlayer >=
        this.#maxQueuedTicks * Math.max(1, resolved.value.program.emitters.length)
      ) {
        if (state.hasCommitted) {
          this.#report({
            code: 'vfx-intent-queue-overflow',
            expected: `at most ${this.#maxQueuedTicks} unconsumed fixed ticks`,
            hint: 'recover or restart the renderer; VFX does not silently discard simulation ticks',
            detail: { player: input.player, maxQueuedTicks: this.#maxQueuedTicks },
          });
        }
        continue;
      }
      const instance =
        this.#instances.get(input.player) ?? this.#createInstance(input.player, resolved.value);
      if (instance === undefined) continue;
      const hasActiveEmitter = resolved.value.program.emitters.some((emitter) => {
        if (!this.isEmitterSessionEnabled(input.player, emitter.id)) return false;
        const cameraVisible = this.#cameraVisibility.get(`${input.player}:${emitter.id}`) ?? true;
        return cameraVisible || emitter.simulationWhenCulled === 'continue';
      });
      if (!hasActiveEmitter) {
        for (const [index, emitter] of resolved.value.program.emitters.entries()) {
          state.cameraVisible[index] =
            this.#cameraVisibility.get(`${input.player}:${emitter.id}`) ?? true;
        }
        continue;
      }
      const replayInput = this.#replayInputs.get(input.player);
      this.#replayInputs.delete(input.player);
      const committed =
        replayInput === undefined
          ? instance.commit({ seed: input.seed, tick })
          : instance.replay(replayInput);
      if (!committed.ok) {
        this.#report({
          code: 'vfx-instance-commit-failed',
          expected: 'the current typed instance values to pack into the reflected GPU block',
          hint: 'repair the instance patch and retry at the next FixedUpdate',
          detail: { player: input.player },
        });
        continue;
      }
      const delta = fixedDelta * input.timeScale;
      const committedChannels = committed.value.channelInputs;
      for (const [index, emitter] of resolved.value.program.emitters.entries()) {
        const cameraVisible = this.#cameraVisibility.get(`${input.player}:${emitter.id}`) ?? true;
        const becameVisible = cameraVisible && state.cameraVisible[index] === false;
        state.cameraVisible[index] = cameraVisible;
        if (!this.isEmitterSessionEnabled(input.player, emitter.id)) continue;
        if (!cameraVisible && emitter.simulationWhenCulled !== 'continue') continue;
        const visibilityRestart =
          becameVisible && emitter.simulationWhenCulled === 'restart-on-visible';
        if (visibilityRestart) {
          state.elapsed[index] = 0;
          state.rateRemainders[index] = 0;
          state.nextParticleIds[index] = 0;
          state.playCycles[index] = (state.playCycles[index] ?? state.playCycle) + 1;
          state.phaseTicks[index] = 0;
        }
        const previousElapsed = state.elapsed[index] ?? 0;
        const scheduled = spawnCount(
          emitter,
          previousElapsed,
          previousElapsed + delta,
          restart || visibilityRestart,
          state.rateRemainders[index] ?? 0,
        );
        state.rateRemainders[index] = scheduled.remainder;
        const firstParticleId = state.nextParticleIds[index] ?? 0;
        state.nextParticleIds[index] = firstParticleId + scheduled.count;
        const consumesEvent = resolved.value.program.emitters.some((source) =>
          (source.events ?? []).some((event) => event.subEmitter === emitter.id),
        );
        const eventSources = resolved.value.program.emitters.flatMap((source) =>
          (source.events ?? []).filter((event) => event.subEmitter === emitter.id),
        );
        const channelInputs =
          (emitter.events?.length ?? 0) > 0 || consumesEvent ? committedChannels : [];
        const phaseTick = state.phaseTicks[index] ?? 0;
        this.#intents.push(
          Object.freeze({
            sequence: this.#sequence++,
            player: input.player,
            emitter,
            programFingerprint: resolved.value.program.fingerprint,
            reset: restart || visibilityRestart,
            fixedDelta: delta,
            phaseTick,
            tick,
            seed: input.seed,
            playCycle: state.playCycles[index] ?? state.playCycle,
            spawnCount: scheduled.count,
            firstParticleId,
            instanceGeneration: committed.value.generation,
            instancePatchCount: committed.value.patchCount,
            parameterBlock: committed.value.parameterBlock,
            canonicalPayload: committed.value.canonicalPayload,
            replayInput: committed.value.replayInput,
            channelInputs,
            eventCounters: eventCounters(
              { channelInputs, emitter },
              channelInputs.length === 0 ? 0 : committed.value.droppedCount,
              eventSources,
            ),
          }),
        );
        state.elapsed[index] = previousElapsed + delta;
        state.phaseTicks[index] = phaseTick + 1;
      }
    }
    for (const player of this.#players.keys()) {
      if (!this.#seen.has(player)) this.reset(player);
    }
  }

  #createInstance(
    player: EntityHandle,
    effect: VfxGpuEffectAsset,
  ): ParticleEffectInstance | undefined {
    const layout = effect.program.emitters.find(
      (emitter) => emitter.reflection.layout !== undefined,
    )?.reflection.layout;
    const reflection: VfxEffectReflection = layout ?? {
      version: 1,
      parameters: { name: 'VfxParameters', fields: [], size: 0, alignment: 1 },
      custom: { name: 'VfxCustom', fields: [], size: 0, alignment: 1 },
      fingerprint: effect.program.fingerprint.startsWith('sha256:')
        ? effect.program.fingerprint
        : `sha256:${effect.program.fingerprint}`,
    };
    try {
      const instance = new ParticleEffectInstance(createVfxEffectContract(reflection), {
        channels: effect.program.emitters.flatMap((emitter) => emitter.channels ?? []),
      });
      this.#instances.set(player, instance);
      return instance;
    } catch {
      this.#report({
        code: 'vfx-instance-commit-failed',
        expected: 'a valid reflected VFX instance contract',
        hint: 'recook the effect with a valid reflection layout before starting the player',
        detail: { player },
      });
      return undefined;
    }
  }

  #latestIntent(player: EntityHandle, emitterId: string): VfxGpuTickIntent | undefined {
    let latest = this.#lastCommittedByEmitter.get(player)?.get(emitterId);
    for (let index = this.#intents.length - 1; index >= 0; index -= 1) {
      const intent = this.#intents[index];
      if (intent?.player !== player || intent.emitter.id !== emitterId) continue;
      if (latest === undefined || intent.sequence > latest.sequence) latest = intent;
      break;
    }
    return latest;
  }
}

function spawnCount(
  emitter: VfxGpuEmitterProgram,
  previous: number,
  next: number,
  firstTick: boolean,
  priorRemainder: number,
): { readonly count: number; readonly remainder: number } {
  const exactRate = emitter.schedule.rate * Math.max(0, next - previous) + priorRemainder;
  let count = Math.floor(exactRate);
  const loop = emitter.schedule.loopDuration;
  for (const burst of emitter.schedule.bursts ?? []) {
    if (loop === undefined) {
      if ((firstTick && burst.time === 0) || (burst.time > previous && burst.time <= next)) {
        count += burst.count;
      }
      continue;
    }
    const firstOccurrence = Math.max(0, Math.floor((previous - burst.time) / loop) + 1);
    const lastOccurrence = Math.floor((next - burst.time) / loop);
    const occurrences = Math.max(0, lastOccurrence - firstOccurrence + 1);
    count += occurrences * burst.count;
    if (firstTick && burst.time === 0) count += burst.count;
  }
  return { count, remainder: exactRate - Math.floor(exactRate) };
}

export function vfxGpuRuntimePlugin(options: VfxGpuRuntimeOptions = {}): Plugin {
  const rows: {
    player: EntityHandle;
    effect: Handle<'ParticleEffectAsset', 'shared'>;
    playing: boolean;
    seed: number;
    timeScale: number;
  }[] = [];
  return {
    name: 'vfx-gpu-runtime',
    build(world) {
      if (world.hasResource(VFX_GPU_RUNTIME_RESOURCE_KEY)) {
        return err(
          new PluginError({
            code: 'plugin-build-failed',
            expected: 'one VFX GPU runtime per World',
            hint: 'reuse the attached VFX host or detach it before installing another',
            detail: {
              pluginName: 'vfx-gpu-runtime',
              cause: `${VFX_GPU_RUNTIME_RESOURCE_KEY} already exists`,
            },
          }),
        );
      }
      const runtime = new VfxGpuRuntime(options);
      world.insertResource(VFX_GPU_RUNTIME_RESOURCE_KEY, runtime);
      const added = world.addSystem(FixedUpdate, {
        name: 'vfx-gpu-runtime',
        queries: [{ with: [Entity, ParticleEffectPlayer] }],
        fn: (world, queryResults) => {
          rows.length = 0;
          for (const row of queryResults[0]) {
            const player = row.get(ParticleEffectPlayer);
            rows.push({
              player: row.entity,
              effect: toShared<'ParticleEffectAsset'>(player.effect),
              playing: player.playing,
              seed: player.seed,
              timeScale: player.timeScale,
            });
          }
          const fixed = world.getResource(FixedTime);
          runtime.advance(world, fixed.tick, fixed.delta, rows);
        },
      });
      if (!added.ok) {
        world.removeResource(VFX_GPU_RUNTIME_RESOURCE_KEY);
        return err(
          new PluginError({
            code: 'plugin-build-failed',
            expected: 'the VFX GPU FixedUpdate system name to be available',
            hint: 'remove the conflicting system before attaching the VFX host',
            detail: { pluginName: 'vfx-gpu-runtime', cause: added.error.code },
          }),
        );
      }
      return ok(undefined);
    },
  };
}

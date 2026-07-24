// audio-tick-system.ts -- M3 (w25) audioTickSystem ECS system + M4 (w31) despawn cleanup
//
// Per-frame system that detects AudioSource playing edges and delegates
// node lifecycle to AudioBackend (D-4 edge-detection model). M4 extends
// with entity despawn detection: entities that disappear between frames
// have their audio nodes stopped and disconnected.
//
// Decision anchors:
// - plan-strategy D-4 (edge-detection tick system, not poll-every-frame)
// - plan-strategy D-5 (bus routing to sfxGain / musicGain per AudioSource.bus)
// - requirements AC-05 (playing edge detection), AC-06 (loop sync), AC-07 (volume sync)
// - requirements AC-09 (bus routing), AC-11 (spatialBlend/PannerNode)
// - requirements AC-12 (despawn entity triggers stop + disconnect)
// - requirements E-4 (invalid clip handle: silent skip, retry next frame)
// - requirements E-5 (mid-frame volume/loop/spatialBlend change: next tick syncs)
// - research Finding 'AudioBufferSourceNode one-shot' (new node per play edge)
//
// charter awareness:
// - P3 explicit failure: tick system silently skips entities without loaded clips
// - P4 consistent abstraction: parallel to spriteAnimationTickSystem pattern
// - F1 limited context: single function export, discoverable from barrel

import type { AudioBackend, AudioPlayOptions, BusName } from '@forgeax/engine-audio';
import { AudioSource } from '@forgeax/engine-audio';
import type { Component, EntityHandle, World } from '@forgeax/engine-ecs';
import { Entity as EntityComponent } from '@forgeax/engine-ecs';
import { WebAudioEngine } from './web-audio-engine';

// ---------------------------------------------------------------------------
// Edge detection helpers (exported for unit testing - w20)
// ---------------------------------------------------------------------------

export type EdgeAction = 'none' | 'play-start' | 'play-stop';

/**
 * Pure edge-detection function: given previous and current playing state,
 * returns the action to take.
 */
export function detectEdge(prev: boolean, current: boolean): EdgeAction {
  if (!prev && current) return 'play-start';
  if (prev && !current) return 'play-stop';
  return 'none';
}

/**
 * Pure function that computes which entities were removed between frames.
 * Compares previous-frame entity IDs to current-frame entity IDs and
 * returns the set that disappeared (needs stop + disconnect cleanup).
 *
 * Exported for unit testing (w29 despawn-cleanup.test.ts).
 */
export function detectRemovedEntities(
  prevEntityIds: readonly number[],
  currentEntityIds: readonly number[],
): number[] {
  const currentSet = new Set(currentEntityIds);
  return prevEntityIds.filter((id) => !currentSet.has(id));
}

// ---------------------------------------------------------------------------
// Internal types for World internals access
// ---------------------------------------------------------------------------

interface ArchetypeView {
  readonly size: number;
  readonly components: ReadonlyArray<{ readonly id: number }>;
  readonly columns: ReadonlyMap<number, ReadonlyMap<string, { readonly view: ArrayLike<number> }>>;
}

/** @internal Accessor for World internals. */
interface WorldInternalView {
  /** @internal */
  _getGraph(): { readonly archetypes: ReadonlyArray<ArchetypeView | undefined> };
}

/**
 * Per-entity tick state: previous-frame `playing` value for edge detection.
 * Lives inside the tick system closure, not in ECS columns.
 */
export interface TickStateEntry {
  prevPlaying: boolean;
}

// ---------------------------------------------------------------------------
// audioTickSystem -- per-frame edge-detect + node lifecycle + property sync
// ---------------------------------------------------------------------------

/**
 * Run one tick of the audio system. Walks all entities carrying `AudioSource`,
 * detects playing state edges (false->true starts playback, true->false stops),
 * and delegates node lifecycle + property sync to the AudioBackend.
 *
 * The system maintains an internal per-entity `Map<Entity, prevPlaying>` for
 * edge detection. Entities whose `AudioClipAsset` buffer is not yet loaded
 * are silently skipped (charter P3 + E-4).
 *
 * @param world  ECS World (for querying AudioSource + resolving clip handles)
 * @param backend AudioBackend instance (WebAudioEngine or mock)
 */
export function audioTickSystem(world: World, backend: AudioBackend): void {
  // F25 de-singleton (D-1): narrow backend to WebAudioEngine for access
  // to instance-scoped tick states. Non-WebAudioEngine backends (no
  // production callers exist -- research Finding 3) fall through as no-op
  // since no tick state management is possible without the private fields.
  const engine = backend instanceof WebAudioEngine ? backend : null;
  if (!engine) return;
  const worldInternal = world as unknown as WorldInternalView;
  const typedWorld = world as unknown as {
    get(
      entity: EntityHandle,
      component: Component,
    ): {
      ok: boolean;
      value?: Record<string, unknown>;
    };
  };

  // `AudioSource.id` is the global token.id. Archetypes without the
  // AudioSource column are skipped by the `componentIds.includes(saId)`
  // guard below, so a World that never registered the component naturally
  // yields an empty walk (D-2).
  const saId = (AudioSource as unknown as Component).id;

  // Resolve clip buffers: for each entity that has an AudioClipAsset handle,
  // resolve through the AssetRegistry (if available in this World).
  const clipResolver = createClipResolver(world);

  const graph = worldInternal._getGraph();
  const currentEntityIds: number[] = [];

  for (const arch of graph.archetypes) {
    if (!arch || arch.size === 0) continue;
    if (!arch.components.some((c) => c.id === saId)) continue;
    const selfCol = arch.columns
      .get((EntityComponent as unknown as Component).id)
      ?.get('self')?.view;
    if (selfCol === undefined) continue;

    for (let i = 0; i < arch.size; i++) {
      const entity = (selfCol[i] ?? 0) as number as EntityHandle;

      const snapRes = typedWorld.get(entity, AudioSource as unknown as Component);
      if (!snapRes.ok || !snapRes.value) continue;

      const row = snapRes.value as Record<string, unknown>;
      const playing = row.playing === true;
      const prev = getPrevState(engine, entity, playing);

      const edge = detectEdge(prev, playing);
      if (edge === 'play-start') {
        // Resolve the clip handle to AudioBuffer
        const clipBuffer = clipResolver(row.clip as number);
        if (clipBuffer) {
          const opts: AudioPlayOptions = {
            loop: row.loop === true,
            volume: typeof row.volume === 'number' ? row.volume : 1,
            spatialBlend: typeof row.spatialBlend === 'number' ? row.spatialBlend : 0,
            bus: (typeof row.bus === 'string' ? row.bus : 'sfx') as BusName,
          };
          const eid = entity as number;
          backend.play(eid, clipBuffer, opts);
        } else {
          // Keep the edge pending until the asynchronously loaded clip is ready.
          const state = engine._tickStates.get(entity as number);
          if (state) state.prevPlaying = false;
        }
      } else if (edge === 'play-stop') {
        backend.stop(entity as number);
      }

      // Per-frame property sync for active sources
      if (playing && edge === 'none') {
        const eid = entity as number;
        if (typeof row.volume === 'number') {
          backend.setVolume(eid, row.volume);
        }
      }

      currentEntityIds.push(entity as number);
    }
  }

  // M4 (w31): detect despawned entities and clean up their audio nodes.
  cleanupDespawnedEntities(engine, currentEntityIds, backend);
}

// ---------------------------------------------------------------------------
// Per-entity state management (edge detection window)
// ---------------------------------------------------------------------------

function getPrevState(engine: WebAudioEngine, entity: EntityHandle, current: boolean): boolean {
  const eid = entity as number;
  const entry = engine._tickStates.get(eid);
  if (!entry) {
    engine._tickStates.set(eid, { prevPlaying: current });
    return false; // initial playing:true is a play-start edge
  }
  const prev = entry.prevPlaying;
  entry.prevPlaying = current;
  return prev;
}

// ---------------------------------------------------------------------------
// Entity lifecycle tracking (despawn detection -- M4 w31)
// ---------------------------------------------------------------------------

/**
 * After processing all current-frame entities, clean up any that
 * disappeared between frames (despawn detection per AC-12).
 *
 * Calls backend.stop() for each removed entity and purges its
 * tick state entry to prevent unbounded memory growth.
 */
function cleanupDespawnedEntities(
  engine: WebAudioEngine,
  currentEntityIds: number[],
  backend: AudioBackend,
): void {
  const removed = detectRemovedEntities([...engine._prevFrameEntities], currentEntityIds);
  for (const eid of removed) {
    backend.stop(eid);
    engine._tickStates.delete(eid);
  }
  // Replace previous-frame set with current for the next tick.
  engine._prevFrameEntities.clear();
  for (const id of currentEntityIds) {
    engine._prevFrameEntities.add(id);
  }
}

// ---------------------------------------------------------------------------
// Clip handle -> AudioBuffer resolution
// ---------------------------------------------------------------------------

/**
 * Creates a clip resolver that looks up clip handles through the ECS World's
 * AssetRegistry resource (if available). Returns undefined when the clip is
 * not yet loaded (E-4 silent skip).
 */
export function createClipResolver(world: World): (clipHandle: number) => AudioBuffer | undefined {
  // feat-20260614 M8 (D-15): audio clips are user-tier column handles resolved
  // through the per-World SharedRefStore. The AssetRegistry no longer holds a
  // handle->payload map (its by-handle `get(handle)` entry point was deleted),
  // so resolve directly via `world.sharedRefs.resolve` -- still no import of
  // @forgeax/engine-runtime (sharedRefs is an ECS-layer surface).
  return (clipHandle: number): AudioBuffer | undefined => {
    const res = world.sharedRefs.resolve<string, { kind?: string; buffer?: AudioBuffer }>(
      clipHandle as unknown as Parameters<typeof world.sharedRefs.resolve>[0],
    );
    if (res.ok && res.value.kind === 'audio' && res.value.buffer !== undefined) {
      return res.value.buffer;
    }
    return undefined;
  };
}

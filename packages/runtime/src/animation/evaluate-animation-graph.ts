// @forgeax/engine-runtime -- evaluateAnimationGraph system (post-order DAG eval).
//
// feat-20260713-animation-state-machine-plugin M3 / w25 (plan D-2 independent
// before-advance system, D-7 eval owns time):
//
// This is the "graph -> N-slot" seam. It runs BEFORE advanceAnimationPlayer (the
// "N-slot -> pose" seam) and is the SOLE writer of the derived slot columns for
// entities carrying an AnimationGraph handle (AnimationPlayer.graph != 0):
//
//   1. Resolve the shared<AnimationGraph> handle to its POD.
//   2. Resolve every clip leaf's shared<AnimationClip> BEFORE writing anything --
//      a dangling handle throws the structured `animation-graph-clip-missing`
//      error so no dirty pose is left (AC-11, plan §8).
//   3. Post-order evaluate effective weights: effective = runtime weight
//      (nodeWeights, default 1) x graph static weight (AC-07 orthogonal product);
//      Blend normalizes its children (AC-04), Add stacks additive layers without
//      normalization (AC-05), nesting propagates a subtree's normalized weight
//      down before its parent combines it (AC-06).
//   4. Advance each clip node's seek-time by nodeSpeeds*dt (wrap/clamp reusing
//      advance's looping logic) and persist it back to nodeTimes (D-7: eval owns
//      the time SSOT).
//   5. Spread one derived slot per clip leaf into the variable clips[] / times[]
//      / weights[] columns and park speeds[]=0 so advance does not re-advance the
//      time (D-7). advance's blend math is left completely unchanged (D-2).
//
// Entities without a graph (graph == 0) are left untouched -- their slots stay
// the direct-write SSOT (single evaluation path, plan D-3). advance's mixing
// math never branches on graph mode; it just consumes whatever fills the slots.

import { resolveAssetHandle } from '@forgeax/engine-assets-runtime';
import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import { createQueryState, defineSystem, Entity, queryRun, Update } from '@forgeax/engine-ecs';
import type { AnimationClip, AnimationGraph, Handle } from '@forgeax/engine-types';
import { AnimationPlayer } from '../components/animation-player';
import { AnimationGraphClipMissingError } from '../errors/animation-graph';
import { ADVANCE_ANIMATION_PLAYER_SYSTEM } from '../systems/advance-animation-player';

/**
 * System name used when `registerEvaluateAnimationGraph` installs the system.
 * External consumers can reference this constant to declare ordering against the
 * graph-evaluation seam.
 */
export const EVALUATE_ANIMATION_GRAPH_SYSTEM = 'evaluateAnimationGraph' as const;

/**
 * Resolved per-entity graph-mode columns (a `world.get` snapshot). `graph` is the
 * raw shared handle (0 = no graph); the three node-* columns are per-node runtime
 * knobs indexed by graph node index.
 */
interface PlayerGraphColumns {
  readonly graph: number;
  readonly nodeWeights: Float32Array;
  readonly nodeTimes: Float32Array;
  readonly nodeSpeeds: Float32Array;
  readonly paused: boolean;
  readonly looping: boolean;
}

/** Read `arr[i]` when in range, else the default (missing per-node knobs default). */
function readAt(arr: Float32Array, i: number, dflt: number): number {
  return i >= 0 && i < arr.length ? (arr[i] ?? dflt) : dflt;
}

/**
 * Wrap / clamp an advanced time against a clip duration -- byte-for-byte the same
 * rule advanceAnimationPlayer applies (looping = modulo into [0, duration);
 * non-looping = clamp to [0, duration]). Shared logic so eval and advance agree
 * on the seek-time domain (D-7).
 */
function wrapTime(time: number, duration: number, looping: boolean): number {
  if (duration <= 0) return time;
  if (looping) {
    let wrapped = time % duration;
    if (wrapped < 0) wrapped += duration;
    return wrapped;
  }
  if (time > duration) return duration;
  if (time < 0) return 0;
  return time;
}

/**
 * Evaluate every graph-carrying AnimationPlayer for one frame, filling the
 * derived N-slot columns. Iterates archetypes via `queryRun` (like advance),
 * collecting entity handles first, then resolving + writing each player outside
 * the transient query bundle.
 */
export function evaluateAnimationGraph(world: World, dt: number): void {
  const state = createQueryState({ with: [AnimationPlayer, Entity] });

  const entities: number[] = [];
  queryRun(state, world, (bundle) => {
    const entitySelf = bundle.Entity.self;
    const rowCount = entitySelf.length;
    for (let row = 0; row < rowCount; row++) {
      entities.push(entitySelf[row] ?? 0);
    }
  });

  for (const entityRaw of entities) {
    evaluateOneEntity(world, entityRaw, dt);
  }
}

/**
 * Evaluate one entity's AnimationGraph into its derived slots. No-op when the
 * entity has no graph (graph == 0) or the graph handle is stale (best-effort
 * skip, like advance skipping an unresolved clip). Throws
 * {@link AnimationGraphClipMissingError} when a clip leaf handle does not resolve
 * -- raised before any write, so no dirty pose is left (AC-11).
 */
function evaluateOneEntity(world: World, entityRaw: number, dt: number): void {
  const entity = entityRaw as EntityHandle;
  const apRes = world.get(entity, AnimationPlayer);
  if (!apRes.ok) return;
  const ap = apRes.value as unknown as PlayerGraphColumns;

  const graphRaw = ap.graph;
  if (graphRaw === 0) return; // no graph -> direct-write path, untouched.

  const graphLookup = resolveAssetHandle<AnimationGraph>(
    world,
    graphRaw as unknown as Handle<'AnimationGraph', 'shared'>,
  );
  if (!graphLookup.ok) return; // stale / despawned graph -> best-effort skip.
  const graph = graphLookup.value;
  if (graph.kind !== 'animation-graph') return;

  const nodes = graph.nodes;
  if (nodes.length === 0) return; // construction rejects empty graphs; guard anyway.

  // Collect clip leaves (ascending node index) and resolve every clip BEFORE any
  // write (AC-11: a dangling handle must not leave a dirty pose).
  const clipNodeIndices: number[] = [];
  const clipHandles: Handle<'AnimationClip', 'shared'>[] = [];
  const clipDurations: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node === undefined || node.type !== 'clip') continue;
    const handle = node.clip;
    const clipLookup = resolveAssetHandle<AnimationClip>(world, handle);
    if (!clipLookup.ok || clipLookup.value.kind !== 'animation-clip') {
      throw new AnimationGraphClipMissingError({ node: i, clip: handle as unknown as number });
    }
    clipNodeIndices.push(i);
    clipHandles.push(handle);
    clipDurations.push(clipLookup.value.duration);
  }

  // Post-order effective-weight evaluation from the root (incoming influence 1).
  const effByNode = new Map<number, number>();
  const runtimeWeight = (n: number): number => readAt(ap.nodeWeights, n, 1);
  const evalNode = (nodeIndex: number, incoming: number): void => {
    const node = nodes[nodeIndex];
    if (node === undefined) return;
    const eff = incoming * runtimeWeight(nodeIndex) * node.weight;
    switch (node.type) {
      case 'clip':
        effByNode.set(nodeIndex, (effByNode.get(nodeIndex) ?? 0) + eff);
        return;
      case 'blend': {
        let total = 0;
        for (const child of node.children)
          total += runtimeWeight(child) * (nodes[child]?.weight ?? 0);
        if (total > 0) {
          for (const child of node.children) evalNode(child, eff / total);
        }
        return;
      }
      case 'add':
        evalNode(node.base, eff);
        for (const layer of node.additive) evalNode(layer, eff);
        return;
    }
  };
  evalNode(graph.root, 1);

  // Advance each clip node's seek-time (D-7: eval owns the time). Persist the full
  // per-node time column so it stays bounded frame-to-frame.
  const newNodeTimes = new Float32Array(nodes.length);
  for (let i = 0; i < nodes.length; i++) newNodeTimes[i] = readAt(ap.nodeTimes, i, 0);
  for (let k = 0; k < clipNodeIndices.length; k++) {
    // biome-ignore lint/style/noNonNullAssertion: parallel to clipNodeIndices
    const nodeIndex = clipNodeIndices[k]!;
    // biome-ignore lint/style/noNonNullAssertion: parallel to clipNodeIndices
    const duration = clipDurations[k]!;
    const current = readAt(ap.nodeTimes, nodeIndex, 0);
    const speed = readAt(ap.nodeSpeeds, nodeIndex, 0);
    const advanced = ap.paused ? current : current + speed * dt;
    newNodeTimes[nodeIndex] = wrapTime(advanced, duration, ap.looping);
  }

  // Spread one derived slot per clip leaf into the variable columns; speeds[]=0
  // parks the time so advance does not re-advance it (D-7).
  const slotCount = clipNodeIndices.length;
  const times = new Float32Array(slotCount);
  const weights = new Float32Array(slotCount);
  const speeds = new Float32Array(slotCount);
  for (let k = 0; k < slotCount; k++) {
    // biome-ignore lint/style/noNonNullAssertion: parallel to clipNodeIndices
    const nodeIndex = clipNodeIndices[k]!;
    weights[k] = effByNode.get(nodeIndex) ?? 0;
    times[k] = newNodeTimes[nodeIndex] ?? 0;
    speeds[k] = 0;
  }

  world.set(entity, AnimationPlayer, {
    clips: clipHandles,
    times,
    weights,
    speeds,
    nodeTimes: newNodeTimes,
  });
}

/**
 * The `evaluateAnimationGraph` system token. Runs `before` advanceAnimationPlayer
 * (plan D-2 / R-5) so the derived slots are ready when advance blends them, and
 * is labelled `'animation'`. Registered by the default `animationPlugin` (w26),
 * so it is on the default path (AC-09), not opt-in.
 */
export const EvaluateAnimationGraph: SystemHandle<readonly []> = defineSystem({
  name: EVALUATE_ANIMATION_GRAPH_SYSTEM,
  queries: [],
  before: [ADVANCE_ANIMATION_PLAYER_SYSTEM],
  fn: (world) => {
    evaluateAnimationGraph(world, 1 / 60);
  },
});

/**
 * Register `evaluateAnimationGraph` into the ECS schedule (before
 * advanceAnimationPlayer). Called by `animationPlugin` so both createApp forms
 * get graph evaluation on the default path for free.
 */
export function registerEvaluateAnimationGraph(world: World): void {
  world.addSystem(Update, EvaluateAnimationGraph);
}

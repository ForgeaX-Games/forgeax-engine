// @forgeax/engine-runtime — advanceAnimationPlayer system (M2 / N-way blend).
//
// Per-tick: scans 4 SoA slots on AnimationPlayer; for each active slot
// (clips[i] != 0), advances times[i] += dt * speeds[i] (paused gates the
// whole entity), samples the AnimationClip channels, and accumulates a
// weighted pose into per-joint TRS accumulators. Once all slots are
// folded in, each joint receives a single `world.set(joint, Transform,
// fullPose)` (research F-2 / F-7 / F-8 — single write per joint per tick).
//
// Blend math (plan-strategy D-1):
//   - translation / scale: linear average — accumulator += w_i * v_i, then
//     accumulator /= Σw_i (per-channel sumW).
//   - rotation: nlerp — first valid quat fixes the sign reference; later
//     quats negated when dot < 0 to take the short arc; accumulator += w * q;
//     finalize = normalize(accumulator). nlerp (not slerp) per D-1 (research
//     F-7: Three.js Normal-mode mathematical form).
//   - per-channel sumW: a joint receiving translation from 2 slots and rotation
//     from 1 slot normalizes each channel by its own sum. Slot weights need not
//     be partitioned-by-1 (research F-2).
//
// Best-effort failure modes (AC-05, plan-strategy D-7 / D-9):
//   - clips[i] == 0          : skip slot, no resolver call (AC-04)
//   - resolver miss          : skip slot
//   - weights[i] < 0         : clamped via max(0, w); not written back (D-7)
//   - duration mismatch      : per-slot modulo on its own duration
//   - channel leaf mismatch  : skip channel
//   - channel missing on slot: per-channel normalize covers it
//
// w5 layers a dev-mode warn pass on top of these silent skips
// (channel-leaf-mismatch / channel-missing-on-some-slot, once per
// (entity, channelKey, reason)).
//
// Decision anchors:
//   - requirements IS-2 / AC-03 / AC-04 / AC-05 (best-effort N-way blend)
//   - plan-strategy D-1 (TRS accumulators + nlerp), D-3 (queryRun, no
//     _getGraph), D-7 (clamp without write-back), D-9 (negative speed
//     natural reverse)
//   - charter P4 (single Transform write per joint per tick)

import type { EntityHandle, SystemHandle, World } from '@forgeax/engine-ecs';
import {
  createQueryState,
  defineSystem,
  defineSystemSet,
  ENTITY_NULL_RAW,
  Entity,
  queryRun,
} from '@forgeax/engine-ecs';
import type { AnimationChannel, AnimationClip, AnimationSampler } from '@forgeax/engine-types';
import { AnimationPlayer } from '../components/animation-player';
import { Name } from '../components/name';
import { Skin } from '../components/skin';
import { Transform } from '../components/transform';

/**
 * System name used when `registerAdvanceAnimationPlayer` installs the system
 * into the ECS schedule. External consumers can reference this constant to
 * declare `after: [ADVANCE_ANIMATION_PLAYER_SYSTEM]` on dependent systems.
 */
export const ADVANCE_ANIMATION_PLAYER_SYSTEM = 'advanceAnimationPlayer' as const;
export const AnimationSet = defineSystemSet({ name: 'animation' });

/**
 * Resource key under which the {@link AnimationAssetResolver} is inserted
 * (M2 — full resource-ification, D-2 / D-7). The `advanceAnimationPlayer`
 * system declares it in `resources` so a missing resolver triggers the
 * structured ParamValidation 'invalid' path rather than a raw throw; the fn
 * body reads it back via `world.getResource(ANIMATION_ASSET_RESOLVER_KEY)`.
 *
 * Aligns with the `TIME_RESOURCE_KEY` / `AUDIO_ENGINE_RESOURCE_KEY` naming
 * convention. Consumers import the constant rather than the bare string so a
 * typo degrades to an import error (charter P3).
 */
export const ANIMATION_ASSET_RESOLVER_KEY = 'AnimationAssetResolver' as const;

export interface AnimationAssetResolver {
  resolveAnimationClip(world: World, handleRaw: number): AnimationClip | undefined;
}

const SLOT_COUNT = 4 as const;

// ────────────────────────────────────────────────────────────────────────────
// Dev-mode warn throttle (plan-strategy D-2 / charter P3)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Module-level WeakMap keyed by World — once-per-(entity, channelKey, reason)
 * warn dedupe (D-2). WeakMap lets a disposed World GC its set automatically;
 * tests reset via `_resetAnimationWarnsForTests`. Production code never
 * clears: a long-running scene accumulates one entry per distinct triple,
 * which is bounded by entity * channel * 2 reasons.
 */
const warnedKeysByWorld: WeakMap<World, Set<string>> = new WeakMap();

type WarnReason = 'channel-leaf-mismatch' | 'channel-missing-on-some-slot';

/**
 * Returns `true` exactly once per (world, entityId, clipHandleRaw, channelIdx,
 * reason) tuple — subsequent calls with the same tuple return `false`. Caller
 * gates the actual `console.warn` so an emitted warn is guaranteed unique.
 */
function shouldWarnOnce(
  world: World,
  entityId: number,
  clipHandleRaw: number,
  channelIdx: number,
  reason: WarnReason,
): boolean {
  let bag = warnedKeysByWorld.get(world);
  if (bag === undefined) {
    bag = new Set();
    warnedKeysByWorld.set(world, bag);
  }
  const key = `${entityId}|${clipHandleRaw}|${channelIdx}|${reason}`;
  if (bag.has(key)) return false;
  bag.add(key);
  return true;
}

/**
 * @internal — Test-only seam: clear the per-World warn-key cache so a test
 * file can replay several `advanceAnimationPlayer` cycles and assert that
 * warns fire once per (entity, channelKey, reason) triple in each replay.
 * Production callers MUST NOT use this — production frames intentionally
 * accumulate the dedupe set so silent-after-first behaviour holds.
 */
export function _resetAnimationWarnsForTests(world: World): void {
  warnedKeysByWorld.delete(world);
}

/**
 * Vite constant-folds `import.meta.env.DEV` at build time so production
 * dead-code-strips this branch. The `process.env.NODE_ENV` fallback covers
 * tsup / esbuild / dawn-node where `import.meta.env` is undefined. Mirrors
 * the seam shape used by `isMeshSsboDevMode` in render-system-record.ts.
 */
function isAnimDevMode(): boolean {
  const importMetaDev = (import.meta as { env?: { DEV?: unknown } }).env?.DEV;
  if (importMetaDev) return true;
  const proc = (globalThis as { process?: { env?: { NODE_ENV?: string } } }).process;
  if (proc === undefined) return false;
  if (proc.env?.NODE_ENV === 'production') return false;
  return true;
}

/**
 * Advance all AnimationPlayer components by dt, blend up to 4 clips per
 * entity, and write one Transform per joint per tick. Returns void.
 *
 * Iteration walks every archetype carrying `[AnimationPlayer, Entity]` via
 * `queryRun` — D-3 retires the archetype graph hand-walk used in M1.
 */
export function advanceAnimationPlayer(
  world: World,
  assetResolver: AnimationAssetResolver,
  dt: number,
): void {
  const state = createQueryState({ with: [AnimationPlayer, Entity] });

  queryRun(state, world, (bundle) => {
    const ap = bundle.AnimationPlayer;
    const entitySelf = bundle.Entity.self;
    const ctx: RowContext = {
      clipsView: ap.clips,
      timesView: ap.times,
      weightsView: ap.weights,
      speedsView: ap.speeds,
      pausedView: ap.paused,
      loopingView: ap.looping,
    };

    const rowCount = entitySelf.length;
    for (let row = 0; row < rowCount; row++) {
      // entitySelf carries the packed u32 handle (encodeEntity(index, gen)).
      // Index 0 + gen 0 encodes to handle 0 — a valid entity, NOT a sentinel
      // (ENTITY_NULL_RAW = 0xffffffff). Treat any column read as authoritative.
      const entityRaw = entitySelf[row] ?? 0;
      const entity = entityRaw as EntityHandle;
      const activeSlots = collectActiveSlotsAndAdvanceTimes(world, ctx, row, assetResolver, dt);
      if (activeSlots.length === 0) continue;
      tickEntityJoints(world, entity, entityRaw, activeSlots);
    }
  });
}

/**
 * Per-row column views, kept in a single object so the inner helpers can
 * read SoA slots without re-extracting fields each call.
 */
interface RowContext {
  readonly clipsView: Uint32Array;
  readonly timesView: Float32Array;
  readonly weightsView: Float32Array;
  readonly speedsView: Float32Array;
  readonly pausedView: Uint8Array;
  readonly loopingView: Uint8Array;
}

/**
 * Walk the 4 SoA slots for `row`: skip `clips[i]==0` (AC-04, no resolver call),
 * skip resolver miss, advance `times[i] += speeds[i]*dt` (paused gates the
 * entity per AC-05), wrap / clamp by clip duration based on `looping`, and
 * keep the slot if `max(0, weights[i]) > 0` (D-7 clamp without write-back).
 *
 * The negative-speed reverse case (D-9) falls out naturally — `newTime`
 * goes negative, the looping branch's `+= duration` re-anchors it; the
 * looping=false branch clamps to 0.
 */
function collectActiveSlotsAndAdvanceTimes(
  world: World,
  ctx: RowContext,
  row: number,
  assetResolver: AnimationAssetResolver,
  dt: number,
): ActiveSlot[] {
  const paused = (ctx.pausedView[row] ?? 0) !== 0;
  const looping = (ctx.loopingView[row] ?? 0) !== 0;
  const base = row * SLOT_COUNT;
  const activeSlots: ActiveSlot[] = [];

  for (let i = 0; i < SLOT_COUNT; i++) {
    const slotOffset = base + i;
    const clipHandleRaw = ctx.clipsView[slotOffset] ?? 0;
    if (clipHandleRaw === 0) continue;
    const clip = assetResolver.resolveAnimationClip(world, clipHandleRaw);
    if (clip === undefined) continue;

    const speed = ctx.speedsView[slotOffset] ?? 0;
    let newTime = paused
      ? (ctx.timesView[slotOffset] ?? 0)
      : (ctx.timesView[slotOffset] ?? 0) + speed * dt;
    const duration = clip.duration;
    if (duration > 0) {
      if (looping) {
        newTime = newTime % duration;
        if (newTime < 0) newTime += duration;
      } else if (newTime > duration) {
        newTime = duration;
      } else if (newTime < 0) {
        newTime = 0;
      }
    }
    ctx.timesView[slotOffset] = newTime;

    const wRaw = ctx.weightsView[slotOffset] ?? 0;
    const w = wRaw > 0 ? wRaw : 0;
    if (w === 0) continue;

    activeSlots.push({ clip, clipHandleRaw, weight: w, time: newTime, slotIdx: i });
  }

  return activeSlots;
}

/**
 * Joint-write pass for one entity: requires Skin + at least one joint;
 * folds every active-slot channel into a per-joint TRS accumulator (linear
 * for translation/scale, nlerp with sign-fixed reference for rotation),
 * then writes one `world.set(joint, Transform, ...)` per touched joint.
 *
 * Dev-mode warns (D-2):
 *   - channel-leaf-mismatch: a clip channel's leaf does not resolve to any
 *     joint name on this entity's Skin. Once per (entityId, clip, chIdx).
 *   - channel-missing-on-some-slot: a (joint, kind) tuple is covered by
 *     some slot but missing on another. The warn is emitted once per
 *     (entityId, the-covering-slot's-clip, that-slot's-chIdx) so users
 *     find the authoring point that has the channel; per-channel sumW
 *     normalize covers the runtime gap regardless.
 */
function tickEntityJoints(
  world: World,
  entity: EntityHandle,
  entityRaw: number,
  activeSlots: ActiveSlot[],
): void {
  const skinResult = world.get(entity, Skin);
  if (!skinResult.ok) return;
  const skinJoints = skinResult.value.joints;
  if (skinJoints.length === 0) return;

  // Per-joint accumulator: lazily allocated when first channel writes.
  // A Map keyed by jointIndex keeps the typical case (a few animated
  // joints out of 20+) sparse rather than allocating for every joint.
  const accumulators: Map<number, JointAccumulator> = new Map();
  // Per-slot signature of (joint, channel-kind) coverage — used to detect
  // channel-missing-on-some-slot once at the end of the channel walk. Lazy
  // build only when there are 2+ active slots and dev-mode is on (warn pass
  // is dead in production via isAnimDevMode constant fold).
  const slotCoverage: SlotCoverage[] = [];
  const wantsCoverage = activeSlots.length >= 2 && isAnimDevMode();
  if (wantsCoverage) {
    for (let i = 0; i < activeSlots.length; i++) slotCoverage.push(new Map());
  }

  for (let slotIdx = 0; slotIdx < activeSlots.length; slotIdx++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded by activeSlots.length
    const slot = activeSlots[slotIdx]!;
    for (let chIdx = 0; chIdx < slot.clip.channels.length; chIdx++) {
      // biome-ignore lint/style/noNonNullAssertion: bounded by channels.length
      const channel = slot.clip.channels[chIdx]!;
      const leaf = channel.targetPath[channel.targetPath.length - 1];
      if (leaf === undefined) continue;

      const jointIndex = resolveJointIndexByName(world, skinJoints, leaf);
      if (jointIndex < 0 || jointIndex >= skinJoints.length) {
        emitLeafMismatchWarn(world, entityRaw, slot.clipHandleRaw, chIdx, leaf);
        continue;
      }

      const sampled = sampleChannel(channel.sampler, slot.time);
      if (sampled === undefined) continue;

      let acc = accumulators.get(jointIndex);
      if (acc === undefined) {
        acc = createAccumulator();
        accumulators.set(jointIndex, acc);
      }

      foldChannelIntoAccumulator(acc, channel.property, sampled, slot.weight);

      if (wantsCoverage) {
        // biome-ignore lint/style/noNonNullAssertion: parallel to activeSlots
        recordSlotCoverage(slotCoverage[slotIdx]!, jointIndex, channel.property, chIdx);
      }
    }
  }

  if (wantsCoverage) {
    emitMissingOnSomeSlotWarns(world, entityRaw, activeSlots, slotCoverage);
  }

  for (const [jointIndex, acc] of accumulators) {
    const jointHandle = skinJoints[jointIndex];
    if (jointHandle === undefined) continue;
    // ENTITY_NULL_RAW (0xFFFFFFFF) is the invalid-entity sentinel;
    // handle 0 (index=0, gen=0) is valid in the ECS index space.
    if (jointHandle === ENTITY_NULL_RAW) continue;
    const jointEntity = jointHandle as unknown as EntityHandle;
    const jointTransform = world.get(jointEntity, Transform as never);
    if (!jointTransform.ok) continue;

    const partial = finalizeAccumulator(acc);
    if (Object.keys(partial).length > 0) {
      world.set(jointEntity, Transform as never, partial as never);
    }
  }
}

/**
 * Per-slot (joint -> covered kinds) signature. The `chIdxByKind` field
 * remembers which channel index of the slot's clip first covered the
 * (joint, kind) pair — used as the channelKey when emitting a
 * channel-missing-on-some-slot warn so the user can locate the
 * authoring channel that exposed the asymmetry.
 */
type ChannelKind = AnimationChannel['property'];
type SlotCoverage = Map<number, Map<ChannelKind, number>>;

function recordSlotCoverage(
  cov: SlotCoverage,
  jointIndex: number,
  kind: ChannelKind,
  chIdx: number,
): void {
  let perJoint = cov.get(jointIndex);
  if (perJoint === undefined) {
    perJoint = new Map();
    cov.set(jointIndex, perJoint);
  }
  if (!perJoint.has(kind)) perJoint.set(kind, chIdx);
}

function emitLeafMismatchWarn(
  world: World,
  entityRaw: number,
  clipHandleRaw: number,
  chIdx: number,
  leaf: string,
): void {
  if (!isAnimDevMode()) return;
  if (!shouldWarnOnce(world, entityRaw, clipHandleRaw, chIdx, 'channel-leaf-mismatch')) return;
  console.warn(
    `[advanceAnimationPlayer] entity=${entityRaw} channel=${clipHandleRaw}:${chIdx} reason=channel-leaf-mismatch joint=${leaf} hint=add a Skin joint named '${leaf}' or rename the clip's targetPath leaf`,
  );
}

/**
 * Reconcile per-slot coverage against the union: for any (joint, kind)
 * tuple covered by ≥ 1 slot but missing on another, emit the warn once per
 * (entityId, the-covering-slot's-clip, that-slot's-chIdx, reason). Each
 * covering slot may emit its own warn pointing at its own channel index —
 * authoring tools can land on any of them.
 */
function emitMissingOnSomeSlotWarns(
  world: World,
  entityRaw: number,
  activeSlots: ActiveSlot[],
  slotCoverage: SlotCoverage[],
): void {
  // Union over all slots: jointIndex -> Set<ChannelKind>.
  const union: Map<number, Set<ChannelKind>> = new Map();
  for (const cov of slotCoverage) {
    for (const [jointIndex, kindMap] of cov) {
      let set = union.get(jointIndex);
      if (set === undefined) {
        set = new Set();
        union.set(jointIndex, set);
      }
      for (const kind of kindMap.keys()) set.add(kind);
    }
  }

  for (const [jointIndex, unionKinds] of union) {
    for (let slotIdx = 0; slotIdx < activeSlots.length; slotIdx++) {
      // biome-ignore lint/style/noNonNullAssertion: parallel arrays
      const cov = slotCoverage[slotIdx]!;
      const slotKinds = cov.get(jointIndex);
      for (const kind of unionKinds) {
        if (slotKinds?.has(kind)) continue;
        // This slot is missing `kind` on jointIndex. Find the slot that
        // does cover (joint, kind) and use ITS chIdx as the warn anchor.
        for (let coveringIdx = 0; coveringIdx < activeSlots.length; coveringIdx++) {
          if (coveringIdx === slotIdx) continue;
          // biome-ignore lint/style/noNonNullAssertion: parallel arrays
          const coveringCov = slotCoverage[coveringIdx]!;
          const coveringKinds = coveringCov.get(jointIndex);
          if (coveringKinds === undefined) continue;
          const chIdx = coveringKinds.get(kind);
          if (chIdx === undefined) continue;
          // biome-ignore lint/style/noNonNullAssertion: parallel arrays
          const coveringSlot = activeSlots[coveringIdx]!;
          if (
            shouldWarnOnce(
              world,
              entityRaw,
              coveringSlot.clipHandleRaw,
              chIdx,
              'channel-missing-on-some-slot',
            )
          ) {
            console.warn(
              `[advanceAnimationPlayer] entity=${entityRaw} channel=${coveringSlot.clipHandleRaw}:${chIdx} reason=channel-missing-on-some-slot joint=${jointIndex} kind=${kind} hint=author the missing ${kind} channel on the slot whose clip lacks it, or accept per-channel normalize fallback`,
            );
          }
          break;
        }
      }
    }
  }
}

/**
 * Add a sampled (translation / rotation / scale) channel to the per-joint
 * accumulator, weighted by the slot's weight. Quat handling sign-fixes
 * against the first quat seen so the nlerp picks the short arc (research
 * F-7); per-channel sumW lets translation / rotation / scale normalize
 * independently when slot coverage differs (research F-2 / AC-05(b)).
 */
function foldChannelIntoAccumulator(
  acc: JointAccumulator,
  property: 'translation' | 'rotation' | 'scale',
  sampled: number[],
  weight: number,
): void {
  if (property === 'translation' && sampled.length >= 3) {
    acc.posX += weight * (sampled[0] ?? 0);
    acc.posY += weight * (sampled[1] ?? 0);
    acc.posZ += weight * (sampled[2] ?? 0);
    acc.sumWPos += weight;
    acc.hasPos = true;
    return;
  }
  if (property === 'rotation' && sampled.length >= 4) {
    const qx = sampled[0] ?? 0;
    const qy = sampled[1] ?? 0;
    const qz = sampled[2] ?? 0;
    const qw = sampled[3] ?? 1;
    if (!acc.hasQuat) {
      acc.refQX = qx;
      acc.refQY = qy;
      acc.refQZ = qz;
      acc.refQW = qw;
      acc.quatX = weight * qx;
      acc.quatY = weight * qy;
      acc.quatZ = weight * qz;
      acc.quatW = weight * qw;
      acc.hasQuat = true;
    } else {
      const dot = acc.refQX * qx + acc.refQY * qy + acc.refQZ * qz + acc.refQW * qw;
      const sign = dot < 0 ? -1 : 1;
      acc.quatX += weight * sign * qx;
      acc.quatY += weight * sign * qy;
      acc.quatZ += weight * sign * qz;
      acc.quatW += weight * sign * qw;
    }
    acc.sumWQuat += weight;
    return;
  }
  if (property === 'scale' && sampled.length >= 3) {
    acc.scaleX += weight * (sampled[0] ?? 1);
    acc.scaleY += weight * (sampled[1] ?? 1);
    acc.scaleZ += weight * (sampled[2] ?? 1);
    acc.sumWScale += weight;
    acc.hasScale = true;
  }
}

/**
 * Per-channel normalize: divide by per-channel sumW. Quat finalize
 * normalizes the resulting vec4 (nlerp). A channel with sumW=0 is silently
 * absent from the partial — `world.set` with a partial leaves untouched
 * fields at their existing values (AC-05(b) per-channel fallback). Channel
 * granularity maps 1:1 onto the Transform array columns (feat-20260709 M2):
 * an animated channel always covers its whole pos/quat/scale vector, so the
 * per-field partial write semantics are unchanged by the column migration.
 */
function finalizeAccumulator(acc: JointAccumulator): Record<string, number[]> {
  const partial: Record<string, number[]> = {};
  if (acc.hasPos && acc.sumWPos > 0) {
    partial.pos = [acc.posX / acc.sumWPos, acc.posY / acc.sumWPos, acc.posZ / acc.sumWPos];
  }
  if (acc.hasQuat && acc.sumWQuat > 0) {
    const qx = acc.quatX / acc.sumWQuat;
    const qy = acc.quatY / acc.sumWQuat;
    const qz = acc.quatZ / acc.sumWQuat;
    const qw = acc.quatW / acc.sumWQuat;
    const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
    if (len > 0) {
      // Component order [x, y, z, w] (E6).
      partial.quat = [qx / len, qy / len, qz / len, qw / len];
    }
  }
  if (acc.hasScale && acc.sumWScale > 0) {
    partial.scale = [
      acc.scaleX / acc.sumWScale,
      acc.scaleY / acc.sumWScale,
      acc.scaleZ / acc.sumWScale,
    ];
  }
  return partial;
}

/**
 * Per-active-slot snapshot folded into the per-entity accumulator pass:
 * the resolved clip + the (advanced) sample time + the clamped weight, so
 * the channel loop never has to re-read the SoA columns.
 */
interface ActiveSlot {
  readonly clip: AnimationClip;
  readonly clipHandleRaw: number;
  readonly weight: number;
  readonly time: number;
  readonly slotIdx: number;
}

interface JointAccumulator {
  posX: number;
  posY: number;
  posZ: number;
  sumWPos: number;
  hasPos: boolean;
  // Quat reference + accumulator. refQ* is the first sampled quat (sign-fixed)
  // so subsequent quats with dot<0 are negated for short-arc nlerp.
  refQX: number;
  refQY: number;
  refQZ: number;
  refQW: number;
  quatX: number;
  quatY: number;
  quatZ: number;
  quatW: number;
  sumWQuat: number;
  hasQuat: boolean;
  scaleX: number;
  scaleY: number;
  scaleZ: number;
  sumWScale: number;
  hasScale: boolean;
}

function createAccumulator(): JointAccumulator {
  return {
    posX: 0,
    posY: 0,
    posZ: 0,
    sumWPos: 0,
    hasPos: false,
    refQX: 0,
    refQY: 0,
    refQZ: 0,
    refQW: 1,
    quatX: 0,
    quatY: 0,
    quatZ: 0,
    quatW: 0,
    sumWQuat: 0,
    hasQuat: false,
    scaleX: 0,
    scaleY: 0,
    scaleZ: 0,
    sumWScale: 0,
    hasScale: false,
  };
}

/**
 * Find the index of a joint in Skin.joints by leaf-name matching.
 *
 * Channel targetPath leaf-name is matched against the Name component of
 * every entity referenced from skinJoints. parse-animation emits
 * targetPath = [nodeName] from the glTF authoring side; postSpawnResolveJoints
 * stamps Name on every joint entity so this lookup is O(joints) per channel.
 */
function resolveJointIndexByName(
  world: World,
  skinJoints: Uint32Array | readonly number[],
  leaf: string,
): number {
  const len = (skinJoints as { length: number }).length;
  for (let i = 0; i < len; i++) {
    const ent = (skinJoints as Uint32Array | readonly number[])[i];
    if (ent === undefined) continue;
    // Note: handle 0 is a VALID entity (slot 0 + gen 0); do NOT short-circuit
    // on `ent === 0`. world.get() does the liveness check itself and returns
    // !ok for stale / despawned handles.
    const nameRes = world.get(ent as unknown as EntityHandle, Name as never);
    if (!nameRes.ok) continue;
    const value = (nameRes.value as { value?: string }).value;
    if (value === leaf) return i;
  }
  return -1;
}

/**
 * Sample an animation sampler at the given time.
 *
 * Returns an array of floats whose length matches the property element count:
 *   - translation / scale: 3 floats (vec3)
 *   - rotation: 4 floats (quat)
 */
function sampleChannel(sampler: AnimationSampler, time: number): number[] | undefined {
  const { input, output, interpolation } = sampler;
  if (input.length === 0) return undefined;

  const elementCount = output.length / input.length;

  // Clamp if before first key.
  if (time <= (input[0] as number)) {
    return sliceOutput(output, 0, elementCount);
  }

  // Clamp if after last key.
  const lastIdx = input.length - 1;
  if (time >= (input[lastIdx] as number)) {
    return sliceOutput(output, lastIdx, elementCount);
  }

  // Binary search for the bracket.
  let lo = 0;
  let hi = input.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((input[mid] as number) <= time) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  const prev = lo;
  const next = hi;

  if (interpolation === 'STEP') {
    return sliceOutput(output, prev, elementCount);
  }

  // LINEAR interpolation.
  const t0 = input[prev] as number;
  const t1 = input[next] as number;
  const alpha = (time - t0) / (t1 - t0);

  const prevValues = sliceOutput(output, prev, elementCount);
  const nextValues = sliceOutput(output, next, elementCount);

  if (elementCount === 4) {
    // Per-sampler quat slerp at the bracket level — multi-slot blending is
    // a separate stage (nlerp at the entity level, in advanceAnimationPlayer).
    const px = prevValues[0] ?? 0;
    const py = prevValues[1] ?? 0;
    const pz = prevValues[2] ?? 0;
    const pw = prevValues[3] ?? 1;
    let nx = nextValues[0] ?? 0;
    let ny = nextValues[1] ?? 0;
    let nz = nextValues[2] ?? 0;
    let nw = nextValues[3] ?? 1;
    let dot = px * nx + py * ny + pz * nz + pw * nw;
    if (dot < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      nw = -nw;
      dot = -dot;
    }
    if (dot > 0.9995) {
      // Near-parallel — fall back to nlerp to avoid sin(theta) -> 0 blowup.
      const lx = px + alpha * (nx - px);
      const ly = py + alpha * (ny - py);
      const lz = pz + alpha * (nz - pz);
      const lw = pw + alpha * (nw - pw);
      const len = Math.sqrt(lx * lx + ly * ly + lz * lz + lw * lw);
      return len > 0 ? [lx / len, ly / len, lz / len, lw / len] : [0, 0, 0, 1];
    }
    const theta = Math.acos(dot);
    const sinTheta = Math.sin(theta);
    const sa = Math.sin((1 - alpha) * theta) / sinTheta;
    const sb = Math.sin(alpha * theta) / sinTheta;
    return [px * sa + nx * sb, py * sa + ny * sb, pz * sa + nz * sb, pw * sa + nw * sb];
  }

  // Vec3 lerp for translation / scale.
  return [
    (prevValues[0] ?? 0) + alpha * ((nextValues[0] ?? 0) - (prevValues[0] ?? 0)),
    (prevValues[1] ?? 0) + alpha * ((nextValues[1] ?? 0) - (prevValues[1] ?? 0)),
    (prevValues[2] ?? 0) + alpha * ((nextValues[2] ?? 0) - (prevValues[2] ?? 0)),
  ];
}

function sliceOutput(output: Float32Array, index: number, elementCount: number): number[] {
  const result: number[] = [];
  const base = index * elementCount;
  for (let i = 0; i < elementCount; i++) {
    result.push(output[base + i] as number);
  }
  return result;
}

/**
 * The `advanceAnimationPlayer` system token (M2 — full resource-ification, D-4).
 *
 * Module-level `defineSystem` with the real fn body — no closure, no
 * placeholder. The fn reads the {@link AnimationAssetResolver} from the World
 * resource ({@link ANIMATION_ASSET_RESOLVER_KEY}); `resources` declares the
 * dependency so a missing resolver routes through the structured
 * ParamValidation 'invalid' path (D-2) instead of a raw throw. Runs
 * `before: ['propagateTransforms']` and is labelled `'animation'`
 * (spec §6.2 label-anchor map).
 */
export const AdvanceAnimationPlayer: SystemHandle<readonly []> = defineSystem({
  name: ADVANCE_ANIMATION_PLAYER_SYSTEM,
  queries: [],
  resources: [ANIMATION_ASSET_RESOLVER_KEY],
  before: ['propagateTransforms'],
  fn: (world) => {
    const assetResolver = world.getResource<AnimationAssetResolver>(ANIMATION_ASSET_RESOLVER_KEY);
    advanceAnimationPlayer(world, assetResolver, 1 / 60);
  },
});

/**
 * Register `advanceAnimationPlayer` into the ECS schedule before
 * `propagateTransforms`. The {@link AnimationAssetResolver} is supplied via the
 * World resource ({@link ANIMATION_ASSET_RESOLVER_KEY}); callers insert it
 * before this system first runs (createApp does so at wire time).
 *
 * @example Driver registers once per World:
 *   const world = new World();
 *   world.insertResource(ANIMATION_ASSET_RESOLVER_KEY, assetResolver);
 *   registerAdvanceAnimationPlayer(world);
 *   // ...system will run each world.update() before propagateTransforms...
 */
export function registerAdvanceAnimationPlayer(world: World): void {
  world.addSystems(AnimationSet, [AdvanceAnimationPlayer]);
}

import {
  gpuDrivenDrawKey,
  gpuDrivenShadowDrawKey,
  gpuDrivenSourceDrawItemIndex,
} from '../extract/gpu-driven';
import { supportsGpuShadowRenderState } from '../material-render-state';
import { worldEntityKey } from '../record/frame-snapshot';
import type { RenderableSnapshot, ShadowCasterMembership } from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import type { GpuDrivenBatch } from './batch-topology';

export function sourceDrawForCandidate(
  slot: PersistentGpuDrivenState['slots'][number],
  candidate: GpuDrivenBatch['candidates'][number],
): NonNullable<RenderableSnapshot['gpuDrivenDraws']>[number] | undefined {
  return slot.snapshot.gpuDrivenDraws?.find(
    (draw, compactIndex) =>
      gpuDrivenSourceDrawItemIndex(draw, compactIndex) === candidate.drawItemIndex,
  );
}

interface ShadowMembershipIndexEntry {
  readonly keys: ReadonlySet<string>;
  readonly memberships: readonly ShadowCasterMembership[];
}

export type ShadowMembershipIndex = ReadonlyMap<string, ShadowMembershipIndexEntry>;

/** Index immutable shadow ownership once for every candidate and cascade lookup. */
export function buildShadowMembershipIndex(
  shadowCasterDrawKeys: ReadonlySet<string> | undefined,
  shadowCasterMembership: readonly ShadowCasterMembership[] | undefined,
): ShadowMembershipIndex | undefined {
  if (shadowCasterDrawKeys === undefined && shadowCasterMembership === undefined) return undefined;
  const mutable = new Map<
    string,
    { readonly keys: Set<string>; readonly memberships: ShadowCasterMembership[] }
  >();
  const entryFor = (base: string) => {
    let entry = mutable.get(base);
    if (entry === undefined) {
      entry = { keys: new Set(), memberships: [] };
      mutable.set(base, entry);
    }
    return entry;
  };
  if (shadowCasterMembership !== undefined) {
    for (const membership of shadowCasterMembership) {
      const base = gpuDrivenDrawKey(
        membership.worldEntity,
        membership.materialHandle,
        membership.drawItemIndex,
      );
      const entry = entryFor(base);
      entry.keys.add(
        gpuDrivenShadowDrawKey(
          membership.worldEntity,
          membership.materialHandle,
          membership.drawItemIndex,
          membership.passIndex,
        ),
      );
      entry.memberships.push(membership);
    }
  } else if (shadowCasterDrawKeys !== undefined) {
    for (const key of shadowCasterDrawKeys) {
      const parts = key.split(':');
      if (parts.length !== 4) continue;
      entryFor(parts.slice(0, 3).join(':')).keys.add(key);
    }
  }
  return mutable;
}

function shadowCandidateBase(
  slot: PersistentGpuDrivenState['slots'][number],
  candidate: GpuDrivenBatch['candidates'][number],
): string | undefined {
  const draw = sourceDrawForCandidate(slot, candidate);
  if (draw === undefined) return undefined;
  const material = slot.snapshot.materials[draw.materialSlot] ?? slot.snapshot.material;
  return gpuDrivenDrawKey(
    worldEntityKey(slot.snapshot.worldId, slot.snapshot.entityKey),
    material.materialHandle ?? -1,
    candidate.drawItemIndex,
  );
}

function shadowKeysForCandidate(
  slot: PersistentGpuDrivenState['slots'][number],
  candidate: GpuDrivenBatch['candidates'][number],
  shadowCasterDrawKeys: ReadonlySet<string> | undefined,
  shadowCasterMembership: readonly ShadowCasterMembership[] | undefined,
  membershipIndex: ShadowMembershipIndex | undefined,
): readonly string[] {
  const candidateBase = shadowCandidateBase(slot, candidate);
  if (candidateBase === undefined) return [];
  const indexed = membershipIndex?.get(candidateBase);
  if (indexed !== undefined) return [...indexed.keys];
  // The index is built from the same membership, so a missing entry proves
  // that no membership row claims this draw.
  if (membershipIndex !== undefined || shadowCasterMembership !== undefined) return [];
  if (shadowCasterDrawKeys === undefined) return [];
  return [...shadowCasterDrawKeys].filter((key) => {
    const parts = key.split(':');
    return parts.length === 4 && `${parts[0]}:${parts[1]}:${parts[2]}` === candidateBase;
  });
}

export interface ShadowCandidateClaim {
  /** Shadow draw keys this candidate would claim for the GPU lane. */
  readonly keys: readonly string[];
  readonly compatible: boolean;
  readonly entry: ShadowCasterMembership | undefined;
}

const NO_SHADOW_CLAIM: ShadowCandidateClaim = Object.freeze({
  keys: Object.freeze([]),
  compatible: false,
  entry: undefined,
});

/**
 * Per-ownership claim table. A claim is a pure function of the retained
 * RenderableSnapshot, the candidate draw item and the ownership source, so
 * every instance candidate of one snapshot and every shadow view share one
 * computed claim until the ownership source identity changes.
 */
export class ShadowClaimTable {
  private readonly bySnapshot = new WeakMap<
    RenderableSnapshot,
    Map<number, ShadowCandidateClaim>
  >();

  constructor(
    private readonly drawKeys: ReadonlySet<string> | undefined,
    private readonly membership: readonly ShadowCasterMembership[] | undefined,
    readonly index: ShadowMembershipIndex | undefined,
  ) {}

  claim(
    slot: PersistentGpuDrivenState['slots'][number],
    candidate: GpuDrivenBatch['candidates'][number],
  ): ShadowCandidateClaim {
    let byDraw = this.bySnapshot.get(slot.snapshot);
    if (byDraw === undefined) {
      byDraw = new Map();
      this.bySnapshot.set(slot.snapshot, byDraw);
    }
    const cached = byDraw.get(candidate.drawItemIndex);
    if (cached !== undefined) return cached;
    const claim = this.compute(slot, candidate);
    byDraw.set(candidate.drawItemIndex, claim);
    return claim;
  }

  private compute(
    slot: PersistentGpuDrivenState['slots'][number],
    candidate: GpuDrivenBatch['candidates'][number],
  ): ShadowCandidateClaim {
    const base = shadowCandidateBase(slot, candidate);
    if (base === undefined) return NO_SHADOW_CLAIM;
    const keys = Object.freeze(
      shadowKeysForCandidate(slot, candidate, this.drawKeys, this.membership, this.index),
    );
    const matching = this.index?.get(base)?.memberships;
    const entry = matching?.[0];
    return Object.freeze({ keys, compatible: this.isCompatible(keys, matching), entry });
  }

  private isCompatible(
    keys: readonly string[],
    matching: readonly ShadowCasterMembership[] | undefined,
  ): boolean {
    if (keys.length !== 1) return false;
    if (this.membership === undefined) return true;
    if (matching?.length !== 1) return false;
    const membership = matching[0];
    if (membership?.cpuReason !== undefined) return false;
    if (!supportsGpuShadowRenderState(membership?.renderState)) return false;
    // Older synthetic membership fixtures omit the producer flag and remain
    // compatible; extracted records always carry it. A false flag is an
    // authored/producer decision and must keep the draw on its CPU lane.
    return membership?.gpuDrivenEligible !== false;
  }
}

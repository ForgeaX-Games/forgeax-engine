import type { PrimitiveTopology } from '@forgeax/engine-types';
import type { BatchTopologyInspection } from '../inspection-types';
import type { RenderSceneApplyResult, RenderSceneSlot } from '../scene/render-scene-types';

export type { BatchTopologyInspection } from '../inspection-types';

export interface GpuDrivenBatchKey {
  readonly assetHandle: number;
  readonly drawKind: 'indexed' | 'non-indexed';
  readonly first: number;
  readonly count: number;
  readonly baseVertex: number;
  readonly materialSlot: number;
  readonly topology: PrimitiveTopology;
  readonly pipelineClass: string;
  readonly materialResourceClass: string;
}

export interface GpuDrivenCandidate {
  readonly primitiveIndex: number;
  readonly generation: number;
  readonly drawItemIndex: number;
  readonly instanceOrdinal: number;
}

export interface GpuDrivenBatch {
  readonly batchId: number;
  readonly generation: number;
  readonly key: GpuDrivenBatchKey;
  readonly candidates: readonly GpuDrivenCandidate[];
  readonly visibleBase: number;
  readonly visibleCapacity: number;
  readonly indirectOffset: number;
}

export interface SubmissionPlan {
  readonly revision: number;
  readonly batches: readonly GpuDrivenBatch[];
  readonly candidateCount: number;
  readonly visibleCapacity: number;
}

interface MutableBatch {
  readonly batchId: number;
  readonly generation: number;
  readonly key: GpuDrivenBatchKey;
  readonly candidates: Map<string, GpuDrivenCandidate>;
}

function eligibleKeys(slot: RenderSceneSlot): readonly GpuDrivenBatchKey[] {
  const snapshot = slot.snapshot;
  const draws = snapshot.gpuDrivenDraws;
  if (
    draws === undefined ||
    draws.length === 0 ||
    snapshot.localAabb === undefined ||
    snapshot.skin !== undefined ||
    snapshot.spriteInstances !== undefined
  ) {
    return [];
  }
  return draws.map((draw) => ({
    assetHandle: snapshot.assetHandle,
    drawKind: draw.kind,
    first: draw.first,
    count: draw.count,
    baseVertex: draw.baseVertex,
    materialSlot: draw.materialSlot,
    topology: draw.topology,
    pipelineClass: draw.pipelineClass,
    materialResourceClass: draw.materialResourceClass,
  }));
}

function keyText(key: GpuDrivenBatchKey): string {
  return JSON.stringify(key);
}

function alignInstanceBase(value: number): number {
  // Raster binds each batch's visible-index and compact-transform segment at
  // a static storage-buffer offset. WebGPU requires those offsets to satisfy
  // minStorageBufferOffsetAlignment (256 bytes on the portable baseline), so
  // both the u32 stream (64 entries) and mat4 stream (4 entries) align when
  // the shared instance base is a multiple of 64.
  return Math.ceil(value / 64) * 64;
}

/** Stable compatibility grouping; per-view visibility never mutates this owner. */
export class BatchTopology {
  private readonly batches = new Map<string, MutableBatch>();
  private readonly membershipByPrimitive = new Map<
    number,
    readonly { readonly batchText: string; readonly candidateKey: string }[]
  >();
  private readonly ineligiblePrimitives = new Set<number>();
  private readonly generationByBatchId: number[] = [];
  private readonly freeBatchIds: number[] = [];
  private revision = 0;
  private rebuilds = 0;
  private patches = 0;
  private cachedPlan: SubmissionPlan | undefined;

  rebuild(slots: readonly RenderSceneSlot[]): void {
    this.batches.clear();
    this.membershipByPrimitive.clear();
    this.ineligiblePrimitives.clear();
    this.generationByBatchId.length = 0;
    this.freeBatchIds.length = 0;
    for (const slot of slots) this.add(slot);
    this.revision += 1;
    this.rebuilds += 1;
    this.cachedPlan = undefined;
  }

  apply(delta: RenderSceneApplyResult): boolean {
    let changed = false;
    for (const removed of delta.removedSlots) changed = this.remove(removed.slot) || changed;
    for (const slot of delta.recreatedSlots) {
      changed = this.remove(slot.slot) || changed;
      changed = this.add(slot) || changed;
    }
    for (const slot of delta.updatedSlots) {
      const instanceCount = slot.snapshot.instances?.instanceCount ?? 1;
      const nextTexts = eligibleKeys(slot).flatMap((key) =>
        Array.from({ length: instanceCount }, () => keyText(key)),
      );
      const current = this.membershipByPrimitive.get(slot.slot) ?? [];
      if (
        current.length === nextTexts.length &&
        current.every((membership, index) => membership.batchText === nextTexts[index])
      ) {
        continue;
      }
      changed = this.remove(slot.slot) || changed;
      changed = this.add(slot) || changed;
    }
    for (const slot of delta.createdSlots) changed = this.add(slot) || changed;
    if (changed) {
      this.revision += 1;
      this.patches += 1;
      this.cachedPlan = undefined;
    }
    return changed;
  }

  plan(): SubmissionPlan {
    if (this.cachedPlan !== undefined) return this.cachedPlan;
    const ordered = [...this.batches.values()].sort((left, right) => left.batchId - right.batchId);
    let visibleBase = 0;
    const batches = ordered.map((batch): GpuDrivenBatch => {
      visibleBase = alignInstanceBase(visibleBase);
      const candidates = [...batch.candidates.values()].sort(
        (left, right) =>
          left.primitiveIndex - right.primitiveIndex ||
          left.drawItemIndex - right.drawItemIndex ||
          left.instanceOrdinal - right.instanceOrdinal,
      );
      const result = {
        batchId: batch.batchId,
        generation: batch.generation,
        key: batch.key,
        candidates,
        visibleBase,
        visibleCapacity: candidates.length,
        indirectOffset: batch.batchId * 20,
      };
      visibleBase += candidates.length;
      return Object.freeze(result);
    });
    this.cachedPlan = Object.freeze({
      revision: this.revision,
      batches: Object.freeze(batches),
      candidateCount: batches.reduce((total, batch) => total + batch.candidates.length, 0),
      visibleCapacity: visibleBase,
    });
    return this.cachedPlan;
  }

  inspect(): BatchTopologyInspection {
    let candidateCount = 0;
    for (const batch of this.batches.values()) candidateCount += batch.candidates.size;
    return {
      revision: this.revision,
      batchCount: this.batches.size,
      candidateCount,
      rebuilds: this.rebuilds,
      patches: this.patches,
      ineligible: this.ineligiblePrimitives.size,
    };
  }

  private add(slot: RenderSceneSlot): boolean {
    const keys = eligibleKeys(slot);
    if (keys.length === 0) {
      this.ineligiblePrimitives.add(slot.slot);
      return false;
    }
    this.ineligiblePrimitives.delete(slot.slot);
    const memberships: Array<{ batchText: string; candidateKey: string }> = [];
    const instanceCount = slot.snapshot.instances?.instanceCount ?? 1;
    for (let drawItemIndex = 0; drawItemIndex < keys.length; drawItemIndex += 1) {
      const key = keys[drawItemIndex];
      if (key === undefined) continue;
      const text = keyText(key);
      let batch = this.batches.get(text);
      if (batch === undefined) {
        const reused = this.freeBatchIds.pop();
        const batchId = reused ?? this.generationByBatchId.length;
        const generation = reused === undefined ? 0 : (this.generationByBatchId[batchId] ?? -1) + 1;
        this.generationByBatchId[batchId] = generation;
        batch = { batchId, generation, key, candidates: new Map() };
        this.batches.set(text, batch);
      }
      for (let instanceOrdinal = 0; instanceOrdinal < instanceCount; instanceOrdinal += 1) {
        const candidateKey = `${slot.slot}:${drawItemIndex}:${instanceOrdinal}`;
        batch.candidates.set(candidateKey, {
          primitiveIndex: slot.slot,
          generation: slot.generation,
          drawItemIndex,
          instanceOrdinal,
        });
        memberships.push({ batchText: text, candidateKey });
      }
    }
    this.membershipByPrimitive.set(slot.slot, memberships);
    return true;
  }

  private remove(primitiveIndex: number): boolean {
    this.ineligiblePrimitives.delete(primitiveIndex);
    const memberships = this.membershipByPrimitive.get(primitiveIndex);
    this.membershipByPrimitive.delete(primitiveIndex);
    if (memberships === undefined) return false;
    for (const membership of memberships) {
      const batch = this.batches.get(membership.batchText);
      if (batch === undefined) continue;
      batch.candidates.delete(membership.candidateKey);
      if (batch.candidates.size === 0) {
        this.batches.delete(membership.batchText);
        this.freeBatchIds.push(batch.batchId);
      }
    }
    return true;
  }
}

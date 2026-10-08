import type { MaterialShaderArtifact } from '@forgeax/engine-shader';
import type { MaterialRenderState } from '@forgeax/engine-types';
import { materialArtifactProgramIdentity } from '../assembly/material/artifact-program-identity';
import type { MeshGpuHandles } from '../device/gpu-residency';
import { gpuDrivenDrawKey, gpuDrivenMaterialArtifactKey } from '../extract/gpu-driven';
import { isStandardPbrMaterialShader, SHADOW_CASTER_SHADER_ID } from '../pbr-pipeline';
import { worldEntityKey } from '../record/frame-snapshot';
import { geometryRenderStateForTopology } from '../record/main-pass-material';
import type {
  MaterialSnapshot,
  RenderableSnapshot,
  ShadowCasterMembership,
} from '../render-system-extract';
import type { PersistentGpuDrivenState } from '../scene/render-scene';
import {
  batchLodLevelCount,
  batchVisibleSpan,
  GPU_DRIVEN_INDIRECT_COMMAND_BYTES,
  type GpuDrivenBatch,
  type GpuDrivenBatchLod,
  type GpuDrivenCandidate,
  type SubmissionPlan,
} from './batch-topology';
import { materialBindingKey } from './material-bindings';
import { lodCrossfadeCapable, prepareLodProjectionPlan } from './production-raster-lod';
import { type ShadowClaimTable, sourceDrawForCandidate } from './shadow-claims';

export interface PreparedBatch {
  readonly batch: GpuDrivenBatch;
  readonly mesh: MeshGpuHandles;
  /** Exact producer artifact selected by every draw in this homogeneous batch. */
  readonly artifact: MaterialShaderArtifact;
  readonly renderState: MaterialRenderState | undefined;
  readonly standardTextureMask: number | undefined;
  /** Stable World attachment key used to join same-submit GPU counters. */
  readonly worldKey: number;
  /** Stable representative slot identity for this homogeneous batch. */
  readonly primitiveSlot: number;
  readonly slotGeneration: number;
}

function hasFiniteOrderedBounds(bounds: Float32Array | undefined): boolean {
  if (bounds === undefined || bounds.length < 6) return false;
  for (let index = 0; index < 6; index += 1) {
    if (!Number.isFinite(bounds[index])) return false;
  }
  const minX = bounds[0];
  const minY = bounds[1];
  const minZ = bounds[2];
  const maxX = bounds[3];
  const maxY = bounds[4];
  const maxZ = bounds[5];
  return (
    minX !== undefined &&
    minY !== undefined &&
    minZ !== undefined &&
    maxX !== undefined &&
    maxY !== undefined &&
    maxZ !== undefined &&
    minX <= maxX &&
    minY <= maxY &&
    minZ <= maxZ
  );
}

export function skinLaneReason(
  snapshot: RenderableSnapshot,
): 'skin-bounds-missing' | 'skin-address-missing' | undefined {
  if (snapshot.skin === undefined) return undefined;
  if (!hasFiniteOrderedBounds(snapshot.skin.bounds)) return 'skin-bounds-missing';
  if (
    snapshot.skin.storageOrUniform !== 'storage' ||
    !Number.isInteger(snapshot.skin.customDataStart) ||
    snapshot.skin.customDataStart < 0 ||
    snapshot.skin.buffer === undefined
  ) {
    return 'skin-address-missing';
  }
  return undefined;
}

export function preparedPbrCandidateEligible(
  snapshot: RenderableSnapshot,
  batch: GpuDrivenBatch,
  artifact: MaterialShaderArtifact | undefined,
): boolean {
  const material = snapshot.materials[batch.key.materialSlot] ?? snapshot.material;
  const prepared = batch.prepared;
  if (prepared === undefined) return false;
  const receipt = artifact?.receipt;
  const publishedAbiMatches =
    receipt !== undefined &&
    artifact?.material === prepared.identity.material &&
    (prepared.receiptIdentity === undefined ||
      (prepared.receiptIdentity === receipt.receiptIdentity &&
        prepared.receiptGeneration === receipt.generation)) &&
    receipt.reflection.layoutIdentity === artifact?.layoutIdentity;
  const alphaBlend = material.transparent === true || material.renderState?.blend !== undefined;
  const cpuOnlyMaterialResources =
    (material.textureSources?.size ?? 0) > 0 || (material.videoTextureFields?.size ?? 0) > 0;
  // Transmission has a separate CPU semantic pass today. Keep it out of the
  // GPU-owned candidate set so the residual transmission draw is not swallowed
  // by the generic Standard PBR lane.
  const transmission =
    isStandardPbrMaterialShader(prepared.identity.material) &&
    typeof material.paramSnapshot?.transmission === 'number' &&
    material.paramSnapshot.transmission > 0;
  const skinReady =
    prepared.identity.deformation !== 'skin' ||
    (artifact?.receipt?.skinPaletteAddress !== undefined &&
      snapshot.skin?.storageOrUniform === 'storage' &&
      snapshot.skin.customDataStart >= 0 &&
      Number.isInteger(snapshot.skin.customDataStart) &&
      snapshot.skin.buffer !== undefined &&
      hasFiniteOrderedBounds(snapshot.skin.bounds));
  return (
    publishedAbiMatches &&
    !alphaBlend &&
    !cpuOnlyMaterialResources &&
    !transmission &&
    (prepared.identity.deformation === 'rigid' || prepared.identity.deformation === 'skin') &&
    skinReady
  );
}

export function meshSupportsBatch(mesh: MeshGpuHandles, batch: GpuDrivenBatch): boolean {
  const lodCount = batch.lod?.coverages.length ?? 0;
  if (
    lodCount > 1 &&
    (mesh.lodRanges === undefined ||
      mesh.lodRanges.length < lodCount ||
      batch.candidates.some((candidate) =>
        mesh.lodRanges?.some((ranges) => ranges[candidate.drawItemIndex] === undefined),
      ))
  ) {
    return false;
  }
  return batch.key.drawKind === 'indexed'
    ? mesh.indexed && mesh.indexBuffer !== null
    : !mesh.indexed;
}

export function shadowCandidateKey(candidate: GpuDrivenBatch['candidates'][number]): string {
  return `${candidate.primitiveIndex}:${candidate.drawItemIndex}:${candidate.instanceOrdinal}`;
}

export interface PreparedProductionCandidate {
  readonly source: GpuDrivenBatch;
  /** Content facts only (entity, materials); per-frame facts come from `slotAt`. */
  readonly slot: PersistentGpuDrivenState['slots'][number];
  readonly candidate: GpuDrivenCandidate;
  /** Batch LOD metadata with the mesh's physical ranges for this draw item. */
  readonly lod: GpuDrivenBatchLod | undefined;
  readonly mesh: MeshGpuHandles;
  readonly artifact: MaterialShaderArtifact;
  readonly material: MaterialSnapshot;
  readonly renderState: MaterialRenderState | undefined;
  readonly worldKey: number;
  readonly groupKey: string;
}

/** Scene-owned admission facts of one source batch, independent of every view. */
export interface PreparedBatchRows {
  readonly source: GpuDrivenBatch;
  readonly rows: readonly PreparedProductionCandidate[];
  readonly eligibleCandidates: readonly string[];
  readonly drawKeys: readonly string[];
  /** Resident mesh consulted for each source candidate; a changed entry re-derives the batch. */
  readonly meshes: readonly (MeshGpuHandles | undefined)[];
}

export function sameBatchMeshes(
  prepared: PreparedBatchRows,
  meshBySlot: ReadonlyMap<number, MeshGpuHandles>,
): boolean {
  const candidates = prepared.source.candidates;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index] as GpuDrivenCandidate;
    if (meshBySlot.get(candidate.primitiveIndex) !== prepared.meshes[index]) return false;
  }
  return true;
}

export interface PreparationInputs {
  readonly slotAt: PersistentGpuDrivenState['slotAt'];
  readonly meshBySlot: ReadonlyMap<number, MeshGpuHandles>;
  readonly worldKeys: readonly number[] | undefined;
  readonly materialArtifact: MaterialShaderArtifact | undefined;
  readonly skinArtifact: MaterialShaderArtifact | undefined;
  readonly materialArtifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined;
}

export function worldKeyForSlot(
  worldKeys: readonly number[] | undefined,
  slot: PersistentGpuDrivenState['slots'][number],
): number {
  return worldKeys?.[slot.snapshot.worldId] ?? slot.snapshot.worldId;
}

export function prepareBatchRows(
  batch: GpuDrivenBatch,
  inputs: PreparationInputs,
): PreparedBatchRows {
  const batchKey = JSON.stringify(batch.key);
  const meshSupport = new Map<MeshGpuHandles, boolean>();
  const rows: PreparedProductionCandidate[] = [];
  const eligibleCandidates: string[] = [];
  const drawKeys: string[] = [];
  const meshes = batch.candidates.map((candidate) =>
    inputs.meshBySlot.get(candidate.primitiveIndex),
  );
  const artifact = artifactForPreparedBatch(
    batch,
    inputs.materialArtifacts,
    inputs.materialArtifact,
    inputs.skinArtifact,
  );
  for (const candidate of batch.candidates) {
    const slot = inputs.slotAt(candidate.primitiveIndex);
    if (slot === undefined || artifact === undefined) continue;
    const mesh = inputs.meshBySlot.get(slot.slot);
    const draw = sourceDrawForCandidate(slot, candidate);
    if (
      draw === undefined ||
      mesh === undefined ||
      !preparedPbrCandidateEligible(slot.snapshot, batch, artifact)
    )
      continue;
    let supportsBatch = meshSupport.get(mesh);
    if (supportsBatch === undefined) {
      supportsBatch = meshSupportsBatch(mesh, batch);
      meshSupport.set(mesh, supportsBatch);
    }
    if (!supportsBatch) continue;
    eligibleCandidates.push(shadowCandidateKey(candidate));
    const drawMaterial = slot.snapshot.materials[draw.materialSlot] ?? slot.snapshot.material;
    const worldKey = worldKeyForSlot(inputs.worldKeys, slot);
    drawKeys.push(
      gpuDrivenDrawKey(
        worldEntityKey(worldKey, slot.snapshot.entityKey),
        drawMaterial.materialHandle ?? -1,
        candidate.drawItemIndex,
      ),
    );
    const material = slot.snapshot.materials[batch.key.materialSlot] ?? slot.snapshot.material;
    const groupKey =
      batchKey +
      JSON.stringify({
        standardTextureMask: material.standardTextureMask,
        artifact: [
          artifact.material,
          artifact.layoutIdentity,
          artifact.receipt?.receiptIdentity ?? '',
          artifact.receipt?.generation ?? 0,
          artifact.variantSet ?? '',
          materialArtifactProgramIdentity(artifact),
        ],
        worldKey,
      });
    const physicalLodRanges = mesh.lodRanges
      ?.slice(1)
      .map((ranges) => ranges[candidate.drawItemIndex]);
    rows.push(
      Object.freeze({
        source: batch,
        slot,
        candidate,
        lod: physicalLodRanges?.every((range) => range !== undefined)
          ? Object.freeze({
              coverages: batch.lod?.coverages ?? [1],
              ...(batch.lod?.hysteresis === undefined ? {} : { hysteresis: batch.lod.hysteresis }),
              ranges: physicalLodRanges as NonNullable<GpuDrivenBatchLod['ranges']>,
            })
          : batch.lod,
        mesh,
        artifact,
        material,
        worldKey,
        groupKey,
        renderState: geometryRenderStateForTopology(batch.key.topology, material.renderState),
      }),
    );
  }
  return Object.freeze({
    source: batch,
    rows: Object.freeze(rows),
    eligibleCandidates: Object.freeze(eligibleCandidates),
    drawKeys: Object.freeze(drawKeys),
    meshes: Object.freeze(meshes),
  });
}

/**
 * Assemble scene-owned admission and ownership from per-batch rows. Only the
 * batches in `rebuilt` were re-derived; the rest are the retained rows of an
 * unchanged `(batchId, generation, contentEpoch)`.
 */
export function assemblePreparedPlan(
  source: SubmissionPlan,
  batchRows: readonly PreparedBatchRows[],
  slots: PersistentGpuDrivenState['slots'],
  worldKeys: readonly number[] | undefined,
) {
  const candidatesByPrimitive = new Map<number, GpuDrivenCandidate[]>();
  const eligibleCandidates = new Set<string>();
  const drawKeys = new Set<string>();
  const rows: PreparedProductionCandidate[] = [];
  for (const [index, batch] of source.batches.entries()) {
    const prepared = batchRows[index] as PreparedBatchRows;
    for (const candidate of batch.candidates) {
      const candidates = candidatesByPrimitive.get(candidate.primitiveIndex);
      if (candidates === undefined)
        candidatesByPrimitive.set(candidate.primitiveIndex, [candidate]);
      else candidates.push(candidate);
    }
    for (const key of prepared.eligibleCandidates) eligibleCandidates.add(key);
    for (const key of prepared.drawKeys) drawKeys.add(key);
    for (const row of prepared.rows) rows.push(row);
  }
  const ownership = slots.map((slot) => {
    const draws = slot.snapshot.gpuDrivenDraws ?? [];
    const candidates = candidatesByPrimitive.get(slot.slot) ?? [];
    const activeKey = worldEntityKey(worldKeyForSlot(worldKeys, slot), slot.snapshot.entityKey);
    const ownsAllDrawItems =
      draws.length > 0 &&
      candidates.length === draws.length * (slot.snapshot.instances?.instanceCount ?? 1) &&
      candidates.every((candidate) => {
        if (!eligibleCandidates.has(shadowCandidateKey(candidate))) return false;
        const draw = sourceDrawForCandidate(slot, candidate);
        if (draw === undefined) return false;
        const material = slot.snapshot.materials[draw.materialSlot] ?? slot.snapshot.material;
        return drawKeys.has(
          gpuDrivenDrawKey(activeKey, material.materialHandle ?? -1, candidate.drawItemIndex),
        );
      });
    return { activeKey, ownsAllDrawItems };
  });
  return {
    source,
    worldKeys,
    rows,
    drawKeys,
    ownership,
    lodPlan: prepareLodProjectionPlan(source),
  };
}

export type PreparedProductionPlan = ReturnType<typeof assemblePreparedPlan>;

/**
 * Project LOD and bindings over prepared rows. Membership covers every
 * resident candidate: per-view admission is a GPU bitmap
 * (`suppressedPrimitiveWords`), so visibility changes never rebuild this plan.
 */
export function filteredPlan(
  prepared: PreparedProductionPlan,
  shadowClaims?: ShadowClaimTable,
  materialBindingClasses?: ReadonlyMap<string, string>,
) {
  const { source } = prepared;
  const shadowDrawKeys = new Set<string>();
  const shadowSelectionProvided = shadowClaims !== undefined;
  const drawKeys = shadowSelectionProvided ? new Set<string>() : prepared.drawKeys;
  const groups = new Map<
    string,
    {
      readonly source: GpuDrivenBatch;
      readonly lod: GpuDrivenBatchLod | undefined;
      readonly mesh: MeshGpuHandles;
      readonly artifact: MaterialShaderArtifact;
      readonly renderState: MaterialRenderState | undefined;
      readonly standardTextureMask: number | undefined;
      readonly candidates: GpuDrivenCandidate[];
      readonly first: PreparedProductionCandidate;
    }
  >();
  // Keep original candidate order even when static grouping descriptions match.
  for (const row of prepared.rows) {
    const { source: batch, candidate, slot, material, lod } = row;
    const shadowClaim = shadowClaims?.claim(slot, candidate);
    if (shadowClaim !== undefined) {
      if (!shadowClaim.compatible) continue;
      for (const key of shadowClaim.keys) shadowDrawKeys.add(key);
    }
    const shadowEntry = shadowClaim?.entry;
    // The GPU cull picks each member's level; crossfade adds the adjacent
    // level across the transition band. Custom shadow casters and
    // non-Standard materials never read the fade, so they select hard.
    const crossfade =
      lodCrossfadeCapable(batch) &&
      !(
        shadowSelectionProvided &&
        shadowEntry !== undefined &&
        shadowEntry.materialShaderId !== SHADOW_CASTER_SHADER_ID
      );
    const batchLod =
      crossfade && lod !== undefined && lod.coverages.length > 1
        ? { ...lod, crossfade: true }
        : lod;
    const groupKey = JSON.stringify({
      group: row.groupKey,
      shadowRenderState: shadowSelectionProvided ? shadowEntry?.renderState : undefined,
      bindingClass:
        materialBindingClasses?.get(
          materialBindingKey(slot.snapshot, material.materialHandle ?? -1),
        ) ?? '',
      lodCoverages: batchLod?.coverages ?? null,
      lodHysteresis: batchLod?.hysteresis ?? null,
      lodRanges: batchLod?.ranges ?? null,
      lodCrossfade: batchLod?.crossfade ?? false,
    });
    let group = groups.get(groupKey);
    if (group === undefined) {
      group = {
        source: batch,
        lod: batchLod,
        mesh: row.mesh,
        artifact: row.artifact,
        renderState: row.renderState,
        standardTextureMask: material.standardTextureMask,
        candidates: [],
        first: row,
      };
      groups.set(groupKey, group);
    }
    group.candidates.push(candidate);
  }
  const batches: PreparedBatch[] = [];
  let visibleBase = 0;
  const filteredBatches: GpuDrivenBatch[] = [];
  let batchId = 0;
  let indirectOffset = 0;
  for (const group of groups.values()) {
    visibleBase = Math.ceil(visibleBase / 64) * 64;
    const admittedCount = group.candidates.length;
    const { lod: _sourceLod, ...sourceFacts } = group.source;
    const filtered: GpuDrivenBatch = Object.freeze({
      ...sourceFacts,
      ...(group.lod === undefined ? {} : { lod: group.lod }),
      batchId,
      candidates: Object.freeze(group.candidates),
      visibleBase,
      visibleCapacity: admittedCount,
      indirectOffset,
    });
    visibleBase += batchVisibleSpan(filtered);
    indirectOffset += batchLodLevelCount(filtered) * GPU_DRIVEN_INDIRECT_COMMAND_BYTES;
    filteredBatches.push(filtered);
    batchId += 1;
    // Every group member shares the material binding class, so the first
    // resident row routes the batch whether or not the GPU admits it.
    const firstSlot = group.first.slot;
    batches.push({
      batch: filtered,
      mesh: group.mesh,
      artifact: group.artifact,
      renderState: group.renderState,
      standardTextureMask: group.standardTextureMask,
      worldKey: worldKeyForSlot(prepared.worldKeys, firstSlot),
      primitiveSlot: firstSlot.slot,
      slotGeneration: firstSlot.generation,
    });
  }
  return {
    plan: Object.freeze({
      revision: source.revision,
      batches: Object.freeze(filteredBatches),
      candidateCount: filteredBatches.reduce((total, batch) => total + batch.candidates.length, 0),
      visibleCapacity: visibleBase,
    }),
    batches: Object.freeze(batches),
    drawKeys,
    shadowDrawKeys,
  };
}

/**
 * Whether the GPU lane owns every draw item of every admitted entity. Entities
 * outside the active set submit nothing on either lane, so they never force
 * the direct path.
 */
export function ownsAllAdmittedDrawItems(
  prepared: PreparedProductionPlan,
  activeEntityKeys: ReadonlySet<number> | undefined,
): boolean {
  return prepared.ownership.every(
    (entry) =>
      (activeEntityKeys !== undefined && !activeEntityKeys.has(entry.activeKey)) ||
      entry.ownsAllDrawItems,
  );
}

/**
 * Per-view admission bitmap over GPU Scene primitive slots: a set bit marks a
 * prepared primitive outside the active entity set.
 */
export function suppressedPrimitiveWords(
  prepared: PreparedProductionPlan,
  activeEntityKeys: ReadonlySet<number>,
  sceneCapacity: number,
): Uint32Array {
  const words = new Uint32Array(Math.max(1, Math.ceil(sceneCapacity / 32)));
  for (const row of prepared.rows) {
    if (activeEntityKeys.has(worldEntityKey(row.worldKey, row.slot.snapshot.entityKey))) continue;
    const primitive = row.candidate.primitiveIndex;
    const word = primitive >>> 5;
    if (word < words.length) words[word] = (words[word] ?? 0) | (1 << (primitive & 31));
  }
  return words;
}

export const EMPTY_SHADOW_KEYS: ReadonlySet<string> = new Set();

export interface ShadowOwnershipSource {
  readonly drawKeys: ReadonlySet<string> | undefined;
  readonly membership: readonly ShadowCasterMembership[] | undefined;
  readonly signature: string;
  readonly casterKeys: ReadonlySet<string> | undefined;
  ownsAllFor: FilteredProductionPlan | undefined;
  ownsAll: boolean;
  /** Undefined when no shadow selection is provided. */
  readonly claims: ShadowClaimTable | undefined;
}

export function shadowCasterMembershipSignature(
  drawKeys: ReadonlySet<string> | undefined,
  membership: readonly ShadowCasterMembership[] | undefined,
): string {
  const keySignature = drawKeys === undefined ? '*' : [...drawKeys].sort().join(',');
  if (membership === undefined) return keySignature;
  const membershipSignature = membership
    .map((entry) =>
      [
        entry.worldEntity,
        entry.renderableIndex,
        entry.drawItemIndex,
        entry.materialHandle,
        entry.passIndex,
        entry.materialShaderId ?? '',
        JSON.stringify(entry.renderState ?? null),
        entry.cpuReason ?? '',
        entry.gpuDrivenEligible === undefined ? '' : String(entry.gpuDrivenEligible),
      ].join(':'),
    )
    .sort()
    .join(',');
  return `${keySignature}|membership=${membershipSignature}`;
}

export type FilteredProductionPlan = ReturnType<typeof filteredPlan>;

export function artifactForPreparedBatch(
  batch: Pick<GpuDrivenBatch, 'prepared'>,
  artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
  rigidFallback: MaterialShaderArtifact | undefined,
  skinFallback: MaterialShaderArtifact | undefined,
): MaterialShaderArtifact | undefined {
  const prepared = batch.prepared;
  if (prepared === undefined) return undefined;
  const exact = artifacts?.get(
    gpuDrivenMaterialArtifactKey({
      material: prepared.identity.material,
      deformation: prepared.identity.deformation,
      receiptIdentity: prepared.receiptIdentity,
      receiptGeneration: prepared.receiptGeneration,
    }),
  );
  if (exact !== undefined) return exact;
  // A map supplied by the real record path is authoritative. A receipt-backed
  // draw missing from it is a producer/load failure, not permission to pair
  // the draw with another material's artifact.
  if (artifacts !== undefined && prepared.receiptIdentity !== undefined) return undefined;
  const fallback = prepared.identity.deformation === 'skin' ? skinFallback : rigidFallback;
  return fallback?.material === prepared.identity.material ? fallback : undefined;
}

export function shadowArtifactForPreparedBatch(
  batch: Pick<GpuDrivenBatch, 'prepared'>,
  artifacts: ReadonlyMap<string, MaterialShaderArtifact> | undefined,
  fallback: MaterialShaderArtifact | undefined,
): MaterialShaderArtifact | undefined {
  const prepared = batch.prepared;
  if (prepared === undefined) return undefined;
  const exact = artifacts?.get(
    gpuDrivenMaterialArtifactKey({
      material: prepared.identity.material,
      deformation: prepared.identity.deformation,
      receiptIdentity: prepared.receiptIdentity,
      receiptGeneration: prepared.receiptGeneration,
    }),
  );
  if (exact !== undefined) return exact;
  // Direct production fixtures predate the separate shadow publication map.
  // They are allowed to reuse the already validated artifact; a real frame
  // passes the authoritative map and therefore fails closed on a missing
  // shadow program instead of silently selecting the forward program.
  return artifacts === undefined ? fallback : undefined;
}

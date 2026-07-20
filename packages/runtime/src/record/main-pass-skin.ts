import { MESH_PER_ENTITY_STRIDE } from './mesh-ssbo';

/**
 * feat-20260612-skin-palette-per-frame-upload M3 / m3-2: pure helper that
 * builds the `setBindGroup(2, ...)` dynamic-offset tuple at the skin /
 * non-skin draw site.
 *
 * - Skin entries (`skinByteOffset !== undefined`) bind a 2-entry mesh-array
 *   BGL (binding 0 mesh-array UBO, binding 1 palette UBO; both
 *   `hasDynamicOffset: true`), so the tuple carries two offsets: the mesh
 *   slot follows the per-entity 256-byte stride; the palette slot carries
 *   the per-entity cursor M2 m2-6 wrote into `entry.source.skin.byteOffset`.
 * - Non-skin entries bind the URP / HDRP 1-entry mesh-array BGL, so the
 *   tuple carries only the mesh slot offset (length 1). Adding a second
 *   offset there would trip WebGPU validation against the 1-binding BGL.
 *
 * Extracted from the inline `group2DynamicOffsets = [i * MESH_PER_ENTITY_STRIDE,
 * 0]` site (PR #353 stub) so the contract `group2DynamicOffsets[1] ===
 * byteOffset` is testable from a focused unit fixture without driving
 * recordFrame end-to-end.
 *
 * @internal -- exported for unit test access (m3-1)
 */
export function _computeSkinGroup2DynOffsets(
  meshSlotIdx: number,
  skinByteOffset: number | undefined,
): readonly number[] {
  const meshOffset = meshSlotIdx * MESH_PER_ENTITY_STRIDE;
  if (skinByteOffset === undefined) return [meshOffset];
  return [meshOffset, skinByteOffset];
}

/**
 * feat-20260612-skin-palette-per-frame-upload M3 / m3-2: read-side accessor
 * for the per-frame skin BG cache miss / hit counters published by the
 * record stage. Mirrors the existing `bindGroupCounts.createBindGroup`
 * surface but scoped to the skin-mesh BG cache so the m3-1 acceptanceCheck
 * (miss=1 + hit=N-1 across N skinned entities sharing one allocator buffer
 * + mesh SSBO) can be observed without traversing the full record-stage
 * dispatch log. The PipelineState carries the mutable counter object
 * (`_skinBgCacheStats: { miss, hit }`); the record-stage cache miss / hit
 * branches bump it; this accessor returns the live reference.
 *
 * @internal -- exported for unit test access (m3-1)
 */
export function _skinBgCacheStats(pipelineState: {
  readonly _skinBgCacheStats: { miss: number; hit: number };
}): { miss: number; hit: number } {
  return pipelineState._skinBgCacheStats;
}

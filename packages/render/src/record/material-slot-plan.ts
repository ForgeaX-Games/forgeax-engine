/**
 * A frame-local material table. Repeated snapshot objects share one UBO slot;
 * each renderable keeps only the slot index used by each authored material.
 */
export interface MaterialSlotPlan<T extends object> {
  readonly slotIndices: readonly (readonly number[])[];
  readonly slots: readonly T[];
  /** Index of the first renderable that referenced each slot. */
  readonly slotOwners: readonly number[];
}

/**
 * Intern identical material snapshots into one frame-local slot table.
 * Snapshot identity is the extract layer's invalidation token, so this keeps
 * the same correctness boundary while avoiding duplicate payload assembly and
 * upload for repeated scene instances.
 */
export function buildMaterialSlotPlan<T extends object>(
  materialGroups: readonly (readonly T[])[],
): MaterialSlotPlan<T> {
  const slotByMaterial = new Map<T, number>();
  const slots: T[] = [];
  const slotOwners: number[] = [];
  const slotIndices = materialGroups.map((materials, ownerIndex) =>
    materials.map((material) => {
      const cached = slotByMaterial.get(material);
      if (cached !== undefined) return cached;
      const slot = slots.length;
      slots.push(material);
      slotOwners.push(ownerIndex);
      slotByMaterial.set(material, slot);
      return slot;
    }),
  );
  return { slotIndices, slots, slotOwners };
}

/**
 * Return the largest complete renderable prefix supported by a shared
 * mesh/material capacity. Mesh rows consume one slot per renderable; material
 * rows use the deduplicated slot indices assigned in first-seen order.
 */
export function findRenderablePrefixForSlotCapacity(
  materialSlotIndices: readonly (readonly number[])[],
  slotCapacity: number,
): number {
  const capacity = Math.max(0, Math.floor(slotCapacity));
  const maxRenderableCount = Math.min(materialSlotIndices.length, capacity);
  let renderableCount = 0;
  while (renderableCount < maxRenderableCount) {
    const slots = materialSlotIndices[renderableCount] ?? [];
    if (slots.some((slot) => slot >= capacity)) break;
    renderableCount += 1;
  }
  return renderableCount;
}

/** Count material slots reachable from a prefix of a first-seen slot plan. */
export function materialSlotCountForPrefix(
  materialSlotIndices: readonly (readonly number[])[],
  renderableCount: number,
): number {
  let maxSlot = -1;
  for (let index = 0; index < renderableCount; index += 1) {
    for (const slot of materialSlotIndices[index] ?? []) maxSlot = Math.max(maxSlot, slot);
  }
  return maxSlot + 1;
}

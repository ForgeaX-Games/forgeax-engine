// @forgeax/engine-ecs — Entity handle.
//
// Encoding: u32 = (generation << 24) | (index & 0xFFFFFF)
//   - index:      24 bits — supports up to 16_777_215 simultaneous entities.
//   - generation:  8 bits — retirement at 255 (index permanently retired).
//
// Key difference from @forgeax/engine-ecs: generation does NOT wrap 255 → 0.
// When generation reaches 255, the index is permanently retired from the
// free list to prevent handle aliasing (D-08).

import { EntityIndexOverflowError } from './errors';

/**
 * Branded `number` representing an Entity handle. Stored as a JS `number` but
 * holds the u32 bit pattern (generation << 24) | index.
 *
 * The phantom `__entity` brand prevents accidental mixing with other numbers.
 *
 * Naming: the type-space alias is `EntityHandle` (the branded number that
 * identifies a row). The same-named value-space `Entity` re-exported from the
 * package barrel is the id=0 component token (see `./entity`).
 */
export type EntityHandle = number & { readonly __entity: unique symbol };

/** Maximum representable entity index (2^24 - 1 = 16_777_215). */
export const ENTITY_MAX_INDEX = (1 << 24) - 1;

/** Maximum representable generation (2^8 - 1 = 255). */
export const ENTITY_MAX_GENERATION = 0xff;

/**
 * Sentinel u32 value reserved for the "null entity" slot in `entity`-typed
 * component fields.
 *
 * The encoding `(gen << 24) | index` yields `0xFFFFFFFF` only at the very
 * last valid (gen=255, index=0xFFFFFF) entity, which retires permanently on
 * its first despawn (D-08). Carving out this single bit pattern as the null
 * sentinel costs at most one slot at the far edge of the entity space.
 *
 * Stored u32 column reads compare against `ENTITY_NULL_RAW` first; the
 * column-level `Entity | null` decode lives in `world.readRow`.
 *
 * Scene-as-World-Blueprint anchor (feat-20260514 w12, R-8 lockdown):
 *   This module (`packages/ecs/src/entity.ts`) is the canonical export site
 *   for the entity null sentinel. Downstream consumers (M2 instantiate
 *   layer 3 fallback for `'entity'`-typed component fields, w22) must import
 *   from the package barrel:
 *
 *     import { ENTITY_NULL_RAW } from '@forgeax/engine-ecs'
 *
 *   The raw `0xFFFFFFFF` literal MUST NOT be duplicated at consumer sites
 *   (charter proposition 1: SSOT lives here). The decoded JS-side value is
 *   `null` (returned by `world.get(e, C).<entityField>`). Layer 3 default
 *   for `'entity'` keyword fields stores `ENTITY_NULL_RAW` into the u32
 *   column, which decodes back to `null` on read. ecs-managed-buffer feat
 *   export verification (w12 grep): see `packages/ecs/src/index.ts` line
 *   re-exporting this constant alongside `ENTITY_MAX_GENERATION /
 *   ENTITY_MAX_INDEX`. No add-only fallback re-export is required at this
 *   time.
 */
export const ENTITY_NULL_RAW = 0xffffffff;

/**
 * Encode (index, generation) into a u32 entity handle.
 *
 * @throws EntityIndexOverflowError when `index > ENTITY_MAX_INDEX` or `index < 0`.
 */
export function encodeEntity(index: number, generation: number): EntityHandle {
  if (index < 0 || index > ENTITY_MAX_INDEX) {
    throw new EntityIndexOverflowError(index);
  }
  // Mask generation to its 8-bit slot.
  const gen = generation & 0xff;
  // `>>> 0` forces u32 sign-free representation (handles gen >= 128 ToInt32 trap).
  return (((gen << 24) | (index & 0xffffff)) >>> 0) as EntityHandle;
}

/** Decode a u32 entity handle into its (index, generation) pair. */
export function decodeEntity(entity: EntityHandle): { index: number; generation: number } {
  const e = entity as unknown as number;
  return {
    index: e & 0xffffff,
    generation: (e >>> 24) & 0xff,
  };
}

/** Extract just the index slot from an entity handle. */
export function entityIndex(entity: EntityHandle): number {
  return (entity as unknown as number) & 0xffffff;
}

/** Extract just the generation slot from an entity handle. */
export function entityGeneration(entity: EntityHandle): number {
  return ((entity as unknown as number) >>> 24) & 0xff;
}

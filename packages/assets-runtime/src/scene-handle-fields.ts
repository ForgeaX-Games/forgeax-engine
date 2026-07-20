// @forgeax/engine-assets-runtime — scene-handle-fields: shared reflection helper for
// SceneAsset handle-field extraction (plan-strategy D-4 / requirements B-5).
//
// `_resolveSceneGuids` (instantiate) and `buildSceneChildContext` (breadcrumb)
// consume this helper so the "identify shared<...> / array<shared<...>> schema
// fields + read GUID string" logic has exactly one authoritative location
// (Derive, Don't Duplicate).
//
// This helper returns raw GUID strings WITHOUT mutating the registry; resolution
// to Handle numbers is the caller's responsibility.
//
// Both consumers prefer the structured `envelope.refs` edges (D-3) when an
// envelope is catalogued for the scene, and fall back to this entity-component
// walk only when no envelope (or no per-entity edge detail) is available:
//  - `_resolveSceneGuids`: envelope-less scenes (e.g. unit tests that build a
//    SceneAsset directly without cataloguing it; no `sceneGuidKey`).
//  - `buildSceneChildContext`: prod GUID-only refs[] edges whose `sourceField`
//    was stripped at the serialization boundary (w7 D-10), plus direct
//    `catalog()` scene registration with no refs. The walk recovers the
//    (entityLocalId, componentName, fieldName, arrayIndex) triple the bare
//    edge no longer carries.

import { resolveComponent } from '@forgeax/engine-ecs';
import type { MountOverride } from '@forgeax/engine-types';

/**
 * A single handle-field reference extracted from a SceneAsset entity.
 *
 * `entityLocalId` is the `node.localId`; `componentName` and `fieldName`
 * identify the schema field whose `fieldType` starts with `shared\<` or
 * `array\<shared\<`. `guidString` is the raw GUID string value from the
 * entity's component data (NOT a parsed `AssetGuid` — callers parse or
 * resolve as needed).
 *
 * `arrayIndex` is `undefined` for plain `handle<T>` fields; for
 * `array<handle<T>>` fields it is the 0-based index into the array.
 */
export interface SceneHandleFieldEntry {
  readonly entityLocalId: number;
  readonly componentName: string;
  readonly fieldName: string;
  readonly guidString: string;
  /** 0-based index for `array<handle<T>>` elements; `undefined` for plain `handle<T>` fields. */
  readonly arrayIndex?: number;
}

/**
 * Shape of a single entity passed to {@link extractSceneEntityHandleGuids}.
 *
 * Compatible with both `SceneEntity` (from `@forgeax/engine-types`, where
 * `components` is `Partial<ComponentValuesMap>`) and test-side plain objects.
 */
interface SceneEntityLike {
  readonly localId: number;
  readonly components: Record<string, Record<string, unknown>>;
}

/**
 * Walk every `SceneEntityLike` in `entities` and extract all GUID strings
 * bound to schema fields with `handle<...>` or `array<handle<...>>` fieldType.
 *
 * Unknown component names (where `resolveComponent` returns `undefined`) are
 * silently skipped — the ecs layer's `additionalProperties` check will catch
 * unknowns at spawn time if appropriate.
 *
 * Values that are already numbers (resolved Handles) or non-strings are
 * skipped (they are not GUID refs).
 *
 * @internal Shared by {@link AssetRegistry._resolveSceneGuids} and
 * `buildSceneChildContext` as the entity-walk fallback used when the structured
 * `envelope.refs` edges are unavailable or carry no per-entity detail.
 */
export function extractSceneEntityHandleGuids(
  entities: ReadonlyArray<SceneEntityLike>,
): SceneHandleFieldEntry[] {
  const entries: SceneHandleFieldEntry[] = [];

  for (const node of entities) {
    const rawComponents: Record<string, Record<string, unknown>> = node.components as Record<
      string,
      Record<string, unknown>
    >;

    for (const compName of Object.keys(rawComponents)) {
      const rawFields = rawComponents[compName];
      if (!rawFields) continue;

      const comp = resolveComponent(compName);
      if (!comp) continue;

      for (const fieldName of Object.keys(rawFields)) {
        forEachHandleGuid(
          comp.schema[fieldName],
          rawFields[fieldName],
          (guidString, arrayIndex) => {
            entries.push({
              entityLocalId: node.localId,
              componentName: compName,
              fieldName,
              guidString,
              ...(arrayIndex !== undefined ? { arrayIndex } : {}),
            });
          },
        );
      }
    }
  }

  return entries;
}

/**
 * One handle-field GUID reference extracted from a {@link MountOverride}'s value
 * (feat-20260713 M3 / w12). Mirrors {@link SceneHandleFieldEntry} but keys on the
 * override's array index (there is no entity `localId` — an override targets a
 * mount member by its own `localId`, resolved by the ecs apply loop, not here).
 *
 * `fieldName` is the schema field the GUID binds to: the override's own `field`
 * for the patch form, or a key of the component-add value map for the add form.
 */
export interface MountOverrideHandleFieldEntry {
  /** 0-based index into the `overrides[]` array passed to the extractor. */
  readonly overrideIndex: number;
  readonly componentName: string;
  readonly fieldName: string;
  readonly guidString: string;
  /** 0-based index for `array<shared<T>>` elements; `undefined` for scalar `shared<T>`. */
  readonly arrayIndex?: number;
}

/**
 * Walk `overrides` and extract every GUID string bound to a `shared<...>` /
 * `array<shared<...>>` schema field inside each override's value (feat-20260713
 * M3 / w12, plan-strategy D-2). This is the apply-side counterpart to
 * {@link extractSceneEntityHandleGuids}: it feeds `resolveMountsRec`'s
 * GUID→handle down-drill so a `mounts[].overrides[].value` carrying a raw GUID
 * (e.g. an `AnimationPlayer.clips` clip GUID) resolves to a live handle before
 * the ecs apply loop, which only ever sees numeric handles (D-2: the GUID domain
 * stays sealed in assets-runtime).
 *
 * The `{comp, field?, value}` discriminant is normalized to `(fieldName, value)`
 * pairs: the patch form (`field` present) yields one pair; the component-add form
 * (`field` absent, `value` is a per-field map) yields one pair per value key.
 * Field type is judged from `resolveComponent(comp).schema[field]`, the same
 * schema SSOT the entity walk uses. Unknown components / non-shared fields /
 * non-string (already-resolved number) values are skipped (D-8 number pass-through).
 *
 * @internal Shared identification core; resolution lives in `resolveMountsRec`.
 */
export function extractMountOverrideHandleGuids(
  overrides: ReadonlyArray<MountOverride>,
): MountOverrideHandleFieldEntry[] {
  const entries: MountOverrideHandleFieldEntry[] = [];

  for (let overrideIndex = 0; overrideIndex < overrides.length; overrideIndex++) {
    const ov = overrides[overrideIndex];
    if (ov === undefined) continue;

    const comp = resolveComponent(ov.comp);
    if (!comp) continue;

    for (const [fieldName, value] of normalizeOverrideFields(ov)) {
      forEachHandleGuid(comp.schema[fieldName], value, (guidString, arrayIndex) => {
        entries.push({
          overrideIndex,
          componentName: ov.comp,
          fieldName,
          guidString,
          ...(arrayIndex !== undefined ? { arrayIndex } : {}),
        });
      });
    }
  }

  return entries;
}

/**
 * Normalize a {@link MountOverride}'s `{comp, field?, value}` shape into
 * `(fieldName, value)` pairs (feat-20260713 M3 / w12). Patch form (`field`
 * present) → one pair; component-add form (`field` absent, `value` a per-field
 * map) → one pair per value key. A non-object add value yields no pairs.
 */
function normalizeOverrideFields(ov: MountOverride): ReadonlyArray<readonly [string, unknown]> {
  if (ov.field !== undefined) return [[ov.field, ov.value]];
  const value = ov.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const map = value as Record<string, unknown>;
  return Object.keys(map).map((key) => [key, map[key]] as const);
}

/**
 * Shared handle-GUID identification core (feat-20260713 M3 / w12 SSOT): given a
 * schema `fieldType` and a `value`, invoke `sink(guidString, arrayIndex?)` for
 * every GUID string the field binds — once for a `shared<T>` scalar string, once
 * per string element of an `array<shared<T>>`. Non-shared fields, non-string
 * scalars, and non-string array elements (already-resolved handle numbers, D-8)
 * are skipped. Both the entity walk and the override walk route through here so
 * the "is this a shared handle field + read its GUID" logic has one home
 * (architecture-principles §1 SSOT).
 */
function forEachHandleGuid(
  fieldType: string | undefined,
  value: unknown,
  sink: (guidString: string, arrayIndex?: number) => void,
): void {
  if (fieldType === undefined || typeof fieldType !== 'string') return;
  if (fieldType.startsWith('shared<')) {
    if (typeof value === 'string') sink(value);
    return;
  }
  if (fieldType.startsWith('array<shared<') && Array.isArray(value)) {
    for (let elemIdx = 0; elemIdx < value.length; elemIdx++) {
      const elem = value[elemIdx];
      if (typeof elem === 'string') sink(elem, elemIdx);
    }
  }
}

// @forgeax/engine-runtime — scene-handle-fields: shared reflection helper for
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
        const value = rawFields[fieldName];
        const fieldType = comp.schema[fieldName];
        if (fieldType === undefined || typeof fieldType !== 'string') continue;

        if (fieldType.startsWith('shared<')) {
          if (typeof value !== 'string') continue;
          entries.push({
            entityLocalId: node.localId,
            componentName: compName,
            fieldName,
            guidString: value,
          });
        } else if (fieldType.startsWith('array<shared<') && Array.isArray(value)) {
          for (let elemIdx = 0; elemIdx < value.length; elemIdx++) {
            const elem = value[elemIdx];
            if (typeof elem !== 'string') continue;
            entries.push({
              entityLocalId: node.localId,
              componentName: compName,
              fieldName,
              guidString: elem,
              arrayIndex: elemIdx,
            });
          }
        }
      }
    }
  }

  return entries;
}

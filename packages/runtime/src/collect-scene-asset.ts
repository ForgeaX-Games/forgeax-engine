// feat-20260623 M2 w11+w12 — SceneInstance → SceneAsset POD collection + pack
// serialization (plan-strategy D-1: pure-data collector, no editor concepts, no
// OverrideRecord / diff-merge — decisions #8 OOS).
//
// A0: engine never learns about "edit" — this is a pure-data read path, not an
// editor mutation. handle→GUID reverse lookup via caller-supplied
// Map<number,string> built externally from AssetRegistry.inspect().
//
// Exports:
//   collectSceneAsset(world, root, handleToGuid?) → SceneAsset
//   serializeSceneAssetToPack(sceneAsset, guid?) → Record<string, unknown>

import {
  type Component as EcsComponent,
  type EntityHandle,
  getRegisteredComponents,
  type World,
} from '@forgeax/engine-ecs';
import type { LocalEntityId, SceneAsset, SceneEntity } from '@forgeax/engine-types';

// ═══════════════════════════════════════════════════════════════════════════════
// Handle-field name allowlists (mirror of asset-registry.ts HANDLE_FIELD_NAMES /
// HANDLE_ARRAY_FIELD_NAMES — keep in sync when new handle<> fields are added).
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Field names known to carry `shared<T>` schema-vocab references.
 * When a new `shared<>` field is added to a runtime component, its field name
 * MUST be added here so the writeback collector correctly resolves it to a GUID.
 */
const HANDLE_FIELD_NAMES: ReadonlySet<string> = new Set([
  'assetHandle',
  'material',
  'skeleton',
  'clip',
  'cubemap',
]);

/**
 * Field names known to carry `array<shared<T>>` schema-vocab references.
 * Each element is a handle that resolves to a GUID string.
 */
const HANDLE_ARRAY_FIELD_NAMES: ReadonlySet<string> = new Set(['materials']);

/**
 * Test whether a value is array-like (either a plain JS Array or a TypedArray
 * such as Uint32Array used by the SoA `array<shared<T, N>>` column backend).
 */
function _isArrayLike(value: unknown): value is ArrayLike<unknown> {
  return (
    Array.isArray(value) ||
    value instanceof Uint32Array ||
    value instanceof Float32Array ||
    value instanceof Int32Array ||
    value instanceof Float64Array ||
    value instanceof Uint8Array ||
    value instanceof Int16Array ||
    value instanceof Uint16Array
  );
}

/**
 * Normalize an array-like value to a plain JS array so consumers see a
 * predictable type.
 */
function _normalizeArray(value: ArrayLike<unknown>): unknown[] {
  return Array.from(value);
}

// ═══════════════════════════════════════════════════════════════════════════════
// collectSceneAsset
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Collect the full component-value POD for every member entity of a
 * materialised SceneInstance back into a {@link SceneAsset}.
 *
 * Read sources (plan-strategy D-1):
 *   - `SceneInstanceState.entityToLocalId` (reverse index: Entity → LocalEntityId)
 *   - `world.get(entity, component)` → `ShapeOf<S>` full field values
 *   - `component.fields` per-field reflection
 *
 * `shared<T>` fields (MeshFilter.assetHandle, MeshRenderer.material,
 * Skin.skeleton, Animation.clip, Skybox.cubemap, MeshRenderer.materials[]) are
 * resolved from handle integers to GUID strings via the optional `handleToGuid`
 * map (built externally from `AssetRegistry.inspect()` — plan-strategy D-1,
 * research Finding 3 gap 1).
 *
 * The returned `SceneAsset.entities[]` is **not** guaranteed to preserve the
 * original entity order from the authored SceneAsset — entities are emitted in
 * insertion order of the `entityToLocalId` map (which reflects spawn order).
 *
 * @param world - The ECS world containing the materialised SceneInstance.
 * @param root - The synthetic root entity carrying the SceneInstance component.
 * @param handleToGuid - Optional `Handle<number>` → GUID string reverse index.
 * @returns A SceneAsset POD with all component values collected from the live
 *          SceneInstance.
 *
 * @example
 *   const instRes = world.get(root, SceneInstance);
 *   const sceneAsset = collectSceneAsset(world, root, handleToGuidMap);
 *   // sceneAsset.entities[i].components[compName][fieldName] reflects live values
 */
export function collectSceneAsset(
  world: World,
  root: EntityHandle,
  handleToGuid?: Map<number, string>,
): SceneAsset {
  const stateRes = world.getSceneInstanceState(root);
  if (!stateRes.ok) {
    // Entity does not carry SceneInstance or the state ref is dead — return an
    // empty SceneAsset.
    return { kind: 'scene', entities: [] };
  }

  const state = stateRes.value;
  // Build a sorted list of (localId, entity) pairs from the reverse map so
  // output order is deterministic (sorted by localId).
  const entries: Array<[LocalEntityId, EntityHandle]> = [];
  for (const [entity, lid] of state.entityToLocalId) {
    entries.push([lid, entity]);
  }
  entries.sort((a, b) => (a[0] as unknown as number) - (b[0] as unknown as number));

  // Pre-fetch the registered component set so we can test each entity against
  // every known component. This is the only way to enumerate an entity's
  // components without per-entity column introspection (which the public API
  // does not expose).
  const registeredComps = getRegisteredComponents();

  const entities: SceneEntity[] = [];
  for (const [lid, entity] of entries) {
    const components: Record<string, Record<string, unknown>> = {};

    for (const [compName, compToken] of registeredComps) {
      const valRes = world.get(entity, compToken as EcsComponent<string>);
      if (!valRes.ok) continue;

      const val = valRes.value as Record<string, unknown>;
      const fields = (compToken as EcsComponent<string>).fields;

      if (!fields || Object.keys(fields).length === 0) continue;

      const fieldValues: Record<string, unknown> = {};
      for (const fieldName of Object.keys(fields)) {
        const rawValue = val[fieldName];

        if (handleToGuid && HANDLE_FIELD_NAMES.has(fieldName) && typeof rawValue === 'number') {
          // shared<T> scalar field: resolve handle → GUID.
          const guid = handleToGuid.get(rawValue);
          fieldValues[fieldName] = guid !== undefined ? guid : rawValue;
        } else if (
          handleToGuid &&
          HANDLE_ARRAY_FIELD_NAMES.has(fieldName) &&
          _isArrayLike(rawValue)
        ) {
          // array<shared<T>> field: resolve each element.
          fieldValues[fieldName] = _normalizeArray(rawValue).map((h: unknown) =>
            typeof h === 'number' ? (handleToGuid.get(h) ?? h) : h,
          );
        } else if (_isArrayLike(rawValue)) {
          // Non-handle array-like value (e.g. array<entity>): normalize to
          // plain JS array for deterministic serialization.
          fieldValues[fieldName] = _normalizeArray(rawValue);
        } else {
          fieldValues[fieldName] = rawValue;
        }
      }

      if (Object.keys(fieldValues).length > 0) {
        components[compName] = fieldValues;
      }
    }

    entities.push({ localId: lid, components } as SceneEntity);
  }

  return { kind: 'scene', entities };
}

// ═══════════════════════════════════════════════════════════════════════════════
// serializeSceneAssetToPack
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Serialize a {@link SceneAsset} into a valid `internal-text-package` pack JSON
 * object (plan-strategy D-1: serialization half of the writeback chain).
 *
 * The output conforms to the engine pack schema v1:
 * ```
 * {
 *   schemaVersion: '1.0.0',
 *   kind: 'internal-text-package',
 *   assets: [{
 *     guid: <scene-guid>,
 *     kind: 'scene',
 *     payload: { entities: [...] },
 *     refs: [<GUID-strings>]
 *   }]
 * }
 * ```
 *
 * `shared<T>` fields that carry GUID strings in the collected SceneAsset are
 * reverse-mapped to integer indices into the per-asset `refs[]` array (the
 * inverse of parseScenePayload in asset-registry.ts). Fields that still carry
 * raw handle numbers (no handleToGuid was provided at collect time) are left
 * as-is.
 *
 * @param sceneAsset - The SceneAsset POD to serialize.
 * @param guid - Optional scene GUID (generated via `crypto.randomUUID()` if
 *               omitted).
 * @returns A valid pack JSON object.
 *
 * @example
 *   const pack = serializeSceneAssetToPack(sceneAsset, sceneGuid);
 *   // pack.assets[0].payload.entities — the scene's entity data
 *   // pack.assets[0].refs — deduplicated GUID list for handle<> fields
 */
export function serializeSceneAssetToPack(
  sceneAsset: SceneAsset,
  guid?: string,
): Record<string, unknown> {
  const assetGuid = guid ?? crypto.randomUUID();

  // Phase 1: walk all entities, collect unique GUIDs from handle fields.
  const guidSet = new Set<string>();
  for (const ent of sceneAsset.entities) {
    const comps = ent.components as Record<string, Record<string, unknown>>;
    for (const compName of Object.keys(comps)) {
      const fields = comps[compName];
      if (!fields) continue;
      for (const fieldName of Object.keys(fields)) {
        const value = fields[fieldName];
        if (HANDLE_FIELD_NAMES.has(fieldName) && typeof value === 'string') {
          guidSet.add(value);
        } else if (HANDLE_ARRAY_FIELD_NAMES.has(fieldName) && Array.isArray(value)) {
          for (const elem of value as ReadonlyArray<unknown>) {
            if (typeof elem === 'string') guidSet.add(elem);
          }
        }
      }
    }
  }

  const refs = [...guidSet];
  const guidToIndex = new Map<string, number>();
  for (const [i, guid] of refs.entries()) {
    guidToIndex.set(guid, i);
  }

  // Phase 2: emit entities with GUID strings replaced by refs indices.
  const serializedEntities: Array<Record<string, unknown>> = [];
  for (const ent of sceneAsset.entities) {
    const serializedComps: Record<string, Record<string, unknown>> = {};
    const comps = ent.components as Record<string, Record<string, unknown>>;
    for (const compName of Object.keys(comps)) {
      const fields = comps[compName];
      if (!fields) continue;
      const serializedFields: Record<string, unknown> = {};
      for (const fieldName of Object.keys(fields)) {
        const value = fields[fieldName];
        if (HANDLE_FIELD_NAMES.has(fieldName) && typeof value === 'string') {
          const idx = guidToIndex.get(value);
          serializedFields[fieldName] = idx !== undefined ? idx : value;
        } else if (HANDLE_ARRAY_FIELD_NAMES.has(fieldName) && Array.isArray(value)) {
          serializedFields[fieldName] = (value as ReadonlyArray<unknown>).map((elem: unknown) => {
            if (typeof elem === 'string') {
              const idx = guidToIndex.get(elem);
              return idx !== undefined ? idx : elem;
            }
            return elem;
          });
        } else {
          serializedFields[fieldName] = value;
        }
      }
      if (Object.keys(serializedFields).length > 0) {
        serializedComps[compName] = serializedFields;
      }
    }
    serializedEntities.push({
      localId: ent.localId as unknown as number,
      components: serializedComps,
    });
  }

  return {
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: assetGuid,
        kind: 'scene',
        payload: { entities: serializedEntities },
        refs,
      },
    ],
  };
}

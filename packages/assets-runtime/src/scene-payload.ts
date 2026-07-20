// @forgeax/engine-assets-runtime -- scene payload parse + ref resolution
// (feat-20260705-runtime-tier2-decomposition M1 / w4, D-4 F1 straight-cut).
// Pure move from asset-registry.ts; zero identifier changes.

import type {
  LocalEntityId,
  SceneAsset,
  SceneEntity,
  SceneInstanceMount,
} from '@forgeax/engine-types';
import { HANDLE_ARRAY_FIELD_NAMES, HANDLE_FIELD_NAMES } from './handles';

/**
 * Structured error returned by parseScenePayload when a refs index is
 * out of bounds (F-2 / AC-02).
 */
interface ParseSceneError {
  readonly localId: number;
  readonly component: string;
  readonly field: string;
  readonly index: number;
  readonly refsLength: number;
}

// Reconstruct a SceneAsset POD from a serialised pack payload (feat-20260514
// w3 / parseAssetPayload 'scene' dispatch). The payload arrives as the
// outer pack file's `assets[i].payload` object after ajv structural
// validation; this helper re-stamps the LocalEntityId brand on each
// SceneEntity.localId field and freezes the resulting POD shape so consumer
// code sees the same readonly surface as a hand-authored SceneAsset (AC-01
// + plan-strategy §3.1 rt_pkg sub-graph).
//
// feat-20260528-scene-asset-guid-refs-and-post-instantiate M1-fixup F-1:
// refs parameter — when provided, integer values in handle-type component
// fields (identified via HANDLE_FIELD_NAMES allowlist, plan-strategy D-4)
// are replaced with refs[N] (GUID string). Non-handle integer fields
// (Transform pos/quat/scale lanes, ChildOf.parent Entity, etc.)
// are kept as-is.
//
// feat-20260528-scene-asset-guid-refs-and-post-instantiate M1-fixup F-2:
// out-of-bounds (N < 0 or N >= refs.length) returns a structured
// ParseSceneError with localId + component + field + index + refs.length
// so the caller can construct a precise AssetError (AC-02).
// The M1 stop-on-first-error (AC-08) behaviour is preserved.
export function parseScenePayload(
  payload: Record<string, unknown>,
  refs?: string[],
): SceneAsset | ParseSceneError | undefined {
  const rawEntities = payload.entities;
  if (!Array.isArray(rawEntities)) return undefined;
  const nodes: SceneEntity[] = [];
  for (const rn of rawEntities as Array<{ localId?: unknown; components?: unknown }>) {
    if (typeof rn.localId !== 'number') return undefined;
    const rawComponents = (rn.components ?? {}) as Record<string, Record<string, unknown>>;

    // Resolve refs indices to GUID strings only for handle-type fields
    // (plan-strategy D-4 / F-1 fix: non-handle integers preserved as-is).
    if (refs) {
      const resolvedComponents: Record<string, Record<string, unknown>> = {};
      for (const compName of Object.keys(rawComponents)) {
        const rawFields = rawComponents[compName];
        if (!rawFields) continue;
        const resolvedFields: Record<string, unknown> = {};
        for (const fieldName of Object.keys(rawFields)) {
          const value = rawFields[fieldName];
          if (
            HANDLE_FIELD_NAMES.has(fieldName) &&
            typeof value === 'number' &&
            Number.isInteger(value)
          ) {
            const idx = value;
            if (idx < 0 || idx >= refs.length) {
              return {
                localId: rn.localId as number,
                component: compName,
                field: fieldName,
                index: idx,
                refsLength: refs.length,
              };
            }
            resolvedFields[fieldName] = refs[idx];
          } else if (HANDLE_ARRAY_FIELD_NAMES.has(fieldName) && Array.isArray(value)) {
            // feat-20260608 M2 / w7: array<handle<X>> field — each element is a
            // refs index resolved to a GUID string. Out-of-bounds in any element
            // surfaces the same ParseSceneError as the scalar handle path.
            const resolvedArr: string[] = [];
            for (let elemIdx = 0; elemIdx < value.length; elemIdx++) {
              const elem = value[elemIdx];
              if (typeof elem !== 'number' || !Number.isInteger(elem)) {
                resolvedFields[fieldName] = value;
                resolvedArr.length = 0;
                break;
              }
              if (elem < 0 || elem >= refs.length) {
                return {
                  localId: rn.localId as number,
                  component: compName,
                  field: `${fieldName}[${elemIdx}]`,
                  index: elem,
                  refsLength: refs.length,
                };
              }
              const ref = refs[elem];
              if (ref !== undefined) resolvedArr.push(ref);
            }
            if (resolvedArr.length === value.length) {
              resolvedFields[fieldName] = resolvedArr;
            } else if (resolvedFields[fieldName] === undefined) {
              resolvedFields[fieldName] = value;
            }
          } else {
            resolvedFields[fieldName] = value;
          }
        }
        resolvedComponents[compName] = resolvedFields as Record<string, unknown>;
      }
      nodes.push({
        localId: rn.localId as LocalEntityId,
        components: resolvedComponents,
      });
    } else {
      nodes.push({
        localId: rn.localId as LocalEntityId,
        components: rawComponents,
      });
    }
  }
  const resolvedMounts = resolveMounts(payload, refs);
  if (resolvedMounts === undefined && Array.isArray(payload.mounts)) {
    // mounts resolution failed (e.g. out-of-bounds source index)
    return undefined;
  }
  // feat-20260612 M2 fixup: resolve `skinGuids` field (refs[] indices on disk
  // -> GUID strings post-parse). The SkinAsset chain has no entity-component
  // hook so the scene must carry an explicit cross-edge list; without it,
  // browser-async-pack-fetch never loads SkinAssets and postSpawnResolveJoints
  // silently skips, leaving Skin.joints.length=0 for every frame.
  const resolvedSkinGuids = resolveSkinGuids(payload, refs);
  if (resolvedSkinGuids === undefined && Array.isArray(payload.skinGuids)) {
    return undefined;
  }
  return {
    kind: 'scene',
    entities: nodes,
    mounts: resolvedMounts as unknown as readonly SceneInstanceMount[],
    ...(resolvedSkinGuids !== undefined ? { skinGuids: resolvedSkinGuids } : {}),
  } as SceneAsset;
}

/**
 * feat-20260612 M2 fixup: resolve `SceneAsset.skinGuids` -- on-disk refs[]
 * indices into post-parse GUID strings. Mirror of {@link resolveMounts}.
 * Returns undefined when no `skinGuids` field is present (back-compat:
 * pre-M2 SceneAssets carry no skin cross-edges).
 */
function resolveSkinGuids(
  payload: Record<string, unknown>,
  refs: readonly string[] | undefined,
): readonly string[] | undefined {
  const raw = payload.skinGuids;
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const item of raw as ReadonlyArray<unknown>) {
    if (typeof item === 'string') {
      // Pre-resolved GUID string (in-memory dawn smoke / direct register path).
      out.push(item);
    } else if (typeof item === 'number' && Number.isInteger(item)) {
      // refs[] index path (browser pack-fetch JSON-roundtrip shape).
      if (refs === undefined) return undefined;
      if (item < 0 || item >= refs.length) return undefined;
      const guid = refs[item];
      if (typeof guid !== 'string') return undefined;
      out.push(guid);
    } else {
      return undefined;
    }
  }
  return out;
}

/**
 * Resolve mounts[].source integer indices through refs[] to GUID strings.
 * Mount.source is resolved positionally (not through HANDLE_FIELD_NAMES),
 * per AC-11. Returns undefined when no mounts field is present (back-compat).
 */
function resolveMounts(
  payload: Record<string, unknown>,
  refs: readonly string[] | undefined,
): ReadonlyArray<Record<string, unknown>> | undefined {
  const rawMounts = payload.mounts;
  if (!Array.isArray(rawMounts)) return undefined;
  if (refs === undefined) return rawMounts as ReadonlyArray<Record<string, unknown>>;
  const resolved: Record<string, unknown>[] = [];
  for (const rm of rawMounts as ReadonlyArray<Record<string, unknown>>) {
    const mount = { ...rm };
    const source = rm.source;
    if (typeof source === 'number' && Number.isInteger(source)) {
      const idx = source;
      if (idx < 0 || idx >= refs.length) {
        return undefined;
      }
      mount.source = refs[idx];
    }
    resolved.push(mount);
  }
  return resolved;
}

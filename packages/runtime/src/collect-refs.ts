// @forgeax/engine-runtime -- collectRefs: dispatch helper for `loadByGuid`'s
// recursive walk. After `loadByGuid` parses an asset POD, it calls
// `collectRefs(asset)` to extract every directly-referenced sub-asset GUID,
// then recursively calls `loadByGuid(ref)` for each before registering the
// top-level asset.
//
// Per-asset-kind walkers for a closed Asset union member. Scene walker filled
// in M1; material / skin in M2.
//
// design D-3: exhaustive switch over asset.kind with no default arm.
// Adding a new kind to the Asset union without extending this switch is a
// compile-time error (TS exhaustiveness check, charter P3 explicit failure),
// verified by src/__tests__/asset-registry.recursive.test-d.ts.

import { type AssetGuid, AssetGuid as AssetGuidParser } from '@forgeax/engine-pack/guid';
import type { Asset } from '@forgeax/engine-types';
import { extractSceneEntityHandleGuids } from './scene-handle-fields';

/**
 * Collect every `AssetGuid` directly referenced by `asset` (one level — OOS-10).
 * Recursion across the full transitive graph is driven by `loadByGuid` itself.
 *
 * Leaf asset kinds return `[]` (no further asset references). Composite kinds
 * (scene, material, skin) walk their reference fields.
 *
 * The scene case delegates to {@link extractSceneEntityHandleGuids} (D-4
 * shared-helper, shared with `_resolveSceneGuids`).
 *
 * @internal Extracted from {@link AssetRegistry} so the exhaustive switch is a
 * standalone compile-time guard for the closed `Asset` union.
 */
export function collectRefs(asset: Asset): readonly AssetGuid[] {
  switch (asset.kind) {
    // === leaves — terminate recursion ===
    case 'mesh':
      return [];
    case 'texture':
      return [];
    case 'cube-texture':
      return [];
    case 'sampler':
      return [];
    case 'shader':
      return [];
    case 'skeleton':
      return [];
    case 'animation-clip':
      return [];
    case 'audio':
      return [];
    case 'font':
      return [];
    case 'render-pipeline':
      return [];

    // === scene — M1 walker (D-4 shared-helper) ===
    case 'scene': {
      // SceneEntity.components is Partial<ComponentValuesMap>, which is
      // structurally compatible with the SceneEntityLike shape consumed by
      // extractSceneEntityHandleGuids (a Record<string, Record<string, unknown>>).
      // The `as` cast is safe because the helper only reads keys + string values
      // from known component schema fields.
      const entries = extractSceneEntityHandleGuids(
        asset.entities as unknown as ReadonlyArray<{
          readonly localId: number;
          readonly components: Record<string, Record<string, unknown>>;
        }>,
      );
      const guids: AssetGuid[] = [];
      for (const entry of entries) {
        const parsed = AssetGuidParser.parse(entry.guidString);
        if (parsed.ok) guids.push(parsed.value);
      }
      // feat-20260612 M2 fixup: surface SkinAsset cross-edges. SkinAssets are
      // siblings of skinned scene entities -- no `handle<SkinAsset>` field
      // exists on any component (Skin only carries the SkeletonAsset handle),
      // so without this branch the browser-async-pack-fetch path never loads
      // SkinAssets, postSpawnResolveJoints silently skips on
      // resolveSkinAsset->undefined, and `Skin.joints` stays length=0 -> the
      // M2-introduced JointCountMismatchError fail-fast triggers every frame.
      if (asset.skinGuids !== undefined) {
        for (const skinGuidStr of asset.skinGuids) {
          const parsed = AssetGuidParser.parse(skinGuidStr);
          if (parsed.ok) guids.push(parsed.value);
        }
      }
      return guids;
    }

    // === material — walk paramValues for AssetGuid string values (D-8) ===
    //
    // MaterialAsset.paramValues is Readonly<Record<string, unknown>>.
    // Values can be GUID strings (pack deserialisation path) or already-resolved
    // Handle numbers (register<MaterialAsset> direct path). Only string values
    // that parse as AssetGuid are collected; numbers and non-GUID strings are
    // skipped (they are plain uniform values like metallic: 0.5 or name: "rough-metal").
    case 'material': {
      if (asset.paramValues === undefined) return [];
      const guids: AssetGuid[] = [];
      for (const value of Object.values(asset.paramValues)) {
        if (typeof value !== 'string') continue;
        const parsed = AssetGuidParser.parse(value);
        if (parsed.ok) guids.push(parsed.value);
      }
      return guids;
    }

    // === skin — single skeletonGuid reference (D-10) ===
    //
    // SkinAsset.skeletonGuid is a string GUID referencing a SkeletonAsset.
    // jointPaths is an entity name path (NOT a GUID) and is NOT collected.
    // If skeletonGuid fails to parse as an AssetGuid, return [] -- the
    // malformed asset POD will be caught by loadByGuid when it tries to
    // register the skin, and the caller's subsequent attempts to use the
    // skeleton will fail-fast with asset-not-found at the loadByGuid level.
    case 'skin': {
      const parsed = AssetGuidParser.parse(asset.skeletonGuid);
      return parsed.ok ? [parsed.value] : [];
    }

    // === tileset — atlases[] managed handles + regions[] indices live inline;
    // no GUID-string refs are carried in the POD payload (feat-20260608 M0 baseline).
    case 'tileset':
      return [];

    // TS exhaustiveness guard: Asset union wider → tsc error here
  }
}

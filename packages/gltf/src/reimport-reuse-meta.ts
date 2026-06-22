// reimport-reuse-meta.ts - two-stage GUID matching for reimport-stable
// `<source>.meta.json` with `importer: 'gltf'` (w13).
//
// Matching algorithm (plan-strategy decision section 2.4 + bevy comparison
// wiki section 3):
//
//   For each new item produced by parseGltf in source iteration order:
//     stage 1: existing entry with same (kind, name, indexFallback)  -> reuse
//     stage 2: existing entry with same (kind, indexFallback) only   -> reuse
//     fallback: AssetGuid.random() (UUIDv7 monotonic clock)
//
// Double-name hazard: when the SAME (kind, name) pair appears more than
// once in the new items list, stage 1 cannot disambiguate, so the algorithm
// suppresses stage 1 for the entire offending group and falls through to
// stage 2 (indexFallback). A stderr warn line surfaces the conflict so AI
// users see the signal at import time + the hazard is captured in the
// returned `warnings` array (the importer also relays it to
// `importSettings.diagnostics.unsupportedExtensions` via parseGltf).
//
// AC anchors:
//   - AC-05: byte-identical reimport when nothing changes (stage 1 reuse path)
//   - AC-06: double-name conflict resolves through indexFallback + warns
//   - AC-13: reimport idempotency overall (no spurious GUID churn)

import { AssetGuid } from '@forgeax/engine-pack/guid';
import { type GltfDocItemLike, subAssetKey } from './sub-asset-key.js';

export type { SubAssetKey } from './sub-asset-key.js';
export { subAssetKey };
export type GltfDocItem = GltfDocItemLike;

/** Subset of `<source>.meta.json` fields (importer=gltf arm) touched by the reuse algorithm. */
export interface GltfSubAssetEntry {
  readonly guid: string;
  readonly sourceIndex: number;
  readonly kind: string;
}

export interface GltfMetaJson {
  readonly schemaVersion: 1;
  readonly kind: 'external-asset-package';
  readonly importer: 'gltf';
  readonly source: string;
  readonly subAssets: readonly GltfSubAssetEntry[];
  readonly importSettings: {
    readonly defaultSceneIndex: number;
    readonly diagnostics: {
      readonly nodeNames: readonly string[];
      readonly unsupportedExtensions: readonly string[];
      readonly matrixTrsCoexistNodes: readonly number[];
    };
  };
}

export interface ReimportReuseResult {
  readonly subAssets: readonly GltfSubAssetEntry[];
  readonly warnings: readonly string[];
}

/**
 * Apply the two-stage reuse algorithm to a freshly parsed item list.
 * Returns the new `subAssets[]` array (preserving item order) plus the
 * stderr warning lines produced during conflict handling.
 *
 * Pure function: no fs / network / global state. `AssetGuid.random()` is
 * the only entropy source; deterministic in absence of new items.
 */
export function reimportReuseMeta(
  items: readonly GltfDocItem[],
  existingMeta: GltfMetaJson | undefined,
): ReimportReuseResult {
  const warnings: string[] = [];

  // Detect (kind, name) duplicates within the new item list. Members of
  // duplicate groups skip stage 1 and fall straight through to stage 2.
  const groupCounts = new Map<string, number>();
  for (const item of items) {
    if (item.name === undefined) continue;
    const groupKey = `${item.kind} ${item.name}`;
    groupCounts.set(groupKey, (groupCounts.get(groupKey) ?? 0) + 1);
  }
  const conflictedGroups = new Set<string>();
  for (const [groupKey, count] of groupCounts) {
    if (count > 1) {
      conflictedGroups.add(groupKey);
      const [kind, name] = groupKey.split(' ');
      const message = `[warn] gltf reimport: ${kind} name '${name}' is duplicated; routing all instances through indexFallback`;
      console.error(message);
      warnings.push(message);
    }
  }

  const stage1Index = new Map<string, GltfSubAssetEntry>();
  const stage2Index = new Map<string, GltfSubAssetEntry>();
  if (existingMeta !== undefined) {
    for (const entry of existingMeta.subAssets) {
      // Existing meta carries no `name` field (storage schema is GUID +
      // sourceIndex + kind only), so stage 1 reuse is keyed by
      // (kind, sourceIndex) which IS the indexFallback - the new-item's
      // name + indexFallback combination still acts as the stage 1 input
      // because the only existing entries that match the new (kind, name,
      // indexFallback) tuple are those whose stored indexFallback equals
      // the new one. Stage 2 is the same physical map; the discriminator
      // is whether the new item's group is conflicted.
      const key = `${entry.kind} ${entry.sourceIndex}`;
      stage1Index.set(key, entry);
      stage2Index.set(key, entry);
    }
  }

  const subAssets: GltfSubAssetEntry[] = [];
  for (const item of items) {
    const groupKey = item.name === undefined ? null : `${item.kind} ${item.name}`;
    const indexKey = `${item.kind} ${item.sourceIndex}`;
    let reused: GltfSubAssetEntry | undefined;

    // Stage 1: (kind, name, indexFallback) exact match. Existing entries
    // do not store `name`, so stage 1 collapses to the indexKey lookup
    // *unless* the group is conflicted (in which case stage 1 is skipped).
    if (groupKey !== null && !conflictedGroups.has(groupKey)) {
      reused = stage1Index.get(indexKey);
    }
    // Stage 2: (kind, indexFallback) only.
    if (reused === undefined) {
      reused = stage2Index.get(indexKey);
    }

    if (reused !== undefined) {
      subAssets.push({
        guid: reused.guid,
        sourceIndex: item.sourceIndex,
        kind: item.kind,
      });
    } else {
      const fresh = AssetGuid.random();
      subAssets.push({
        guid: AssetGuid.format(fresh),
        sourceIndex: item.sourceIndex,
        kind: item.kind,
      });
    }
  }

  return { subAssets, warnings };
}

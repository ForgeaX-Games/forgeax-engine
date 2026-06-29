import { AssetGuid } from '@forgeax/engine-pack/guid';
import type { DecodedImage, ImageColorSpace } from '@forgeax/engine-types';

import type { SubAssetKey } from './sub-asset-key.js';
import { subAssetKey, subAssetKeyEqual } from './sub-asset-key.js';

/**
 * Existing `*.meta.json` (importer: 'image') sub-asset record (free-form sub-shape; the
 * meta.schema.json $defs/subAsset locks `guid` + `sourceIndex` + `kind` only).
 * Image importer treats the open shape as a key-bearing tuple; the gltf-loader
 * feat works on the same shape.
 */
export interface ExistingSubAsset {
  readonly guid: string;
  readonly sourceIndex: number;
  readonly kind: string;
  readonly name?: string;
}

/**
 * Existing `*.meta.json` (importer: 'image') package record. Mirrors the
 * meta.schema.json $defs/ExternalAssetPackage shape (research F-9). Only
 * the fields consumed by the reimport reuse algorithm are typed here;
 * importSettings stays a free-form open shape.
 */
export interface ExistingExternalAssetPackage {
  readonly schemaVersion: string;
  readonly kind: 'external-asset-package';
  readonly importer: 'image';
  readonly source: string;
  readonly importSettings: Readonly<Record<string, unknown>>;
  readonly subAssets: readonly ExistingSubAsset[];
}

/**
 * Sub-asset record emitted into the regenerated `*.meta.json` (importer: 'image')
 * `subAssets[]` slot. Shape matches `ExistingSubAsset` so two consecutive
 * reimports of byte-identical bytes produce byte-identical JSON
 * (AC-16 byte-stable reimport guarantee).
 */
export interface EmittedSubAsset {
  readonly guid: string;
  readonly sourceIndex: number;
  readonly kind: string;
  readonly name?: string;
}

/**
 * Two-phase reimport reuse algorithm (plan-strategy section 2.2 D-4
 * mirroring the in-flight gltf-loader algorithm).
 *
 * For each fresh sub-asset key the importer would emit, this function:
 *  1. Searches the `existing.subAssets[]` for a `subAssetKeyEqual` hit.
 *  2. On hit -- reuses the existing GUID byte-for-byte.
 *  3. On miss -- mints a fresh UUIDv7 via `AssetGuid.random()`.
 *
 * Image disk schema currently emits a single `kind='image'` sub-asset per
 * source (cubemap face / array layer reserved for future feat); the
 * algorithm scales to multi-sub-asset sources without modification (charter
 * P5 consistent abstraction).
 *
 * Returns the regenerated `subAssets[]` array. The caller (toAssetPack /
 * runAssetImport) splices it into the `*.meta.json` (importer: 'image') envelope.
 */
export function reimportReuseMeta(
  decoded: DecodedImage,
  existing: ExistingExternalAssetPackage | undefined,
): readonly EmittedSubAsset[] {
  // Image disk schema is single-sub-asset; the future multi-asset path
  // iterates a producer-side list of sub-asset keys instead of a single one.
  const freshKeys: readonly SubAssetKey[] = [subAssetKey({ kind: 'image', sourceIndex: 0 })];

  const out: EmittedSubAsset[] = [];

  for (let i = 0; i < freshKeys.length; i++) {
    const fresh = freshKeys[i];
    if (fresh === undefined) continue;

    let reuseGuid: string | undefined;
    if (existing !== undefined) {
      for (const candidate of existing.subAssets) {
        const candidateKey = subAssetKey({
          kind: candidate.kind,
          sourceIndex: candidate.sourceIndex,
          ...(candidate.name !== undefined ? { name: candidate.name } : {}),
        });
        if (subAssetKeyEqual(fresh, candidateKey)) {
          reuseGuid = candidate.guid;
          break;
        }
      }
    }

    const guid = reuseGuid ?? AssetGuid.format(AssetGuid.random());
    const emit: EmittedSubAsset =
      fresh.name !== undefined
        ? { guid, sourceIndex: i, kind: fresh.kind, name: fresh.name }
        : { guid, sourceIndex: i, kind: fresh.kind };
    out.push(emit);
  }

  // Ensure decoded ref is consumed (decoded.bytes is the producer signal that
  // a sub-asset exists; without bytes there is nothing to emit). The
  // signature keeps `decoded` in the public surface so the future cubemap /
  // array-layer feat can derive its multi-sub-asset list from `decoded`
  // metadata without a breaking change (charter P5 consistent abstraction).
  void decoded;

  return out;
}

/**
 * HDR colorSpace validator for *.image.meta.json sidecar importSettings
 * (plan-strategy D-8 -- HDR files must use colorSpace=linear).
 *
 * Extension is matched case-insensitively against the HDR set
 * (`.hdr`, `.exr`). When the extension belongs to the HDR set:
 * - `colorSpace='linear'` -> ok, returns `'linear'`
 * - any other colorSpace -> structured rejection with expected/actual
 *
 * Non-HDR extensions pass through the colorSpace unchanged. Downstream
 * callers (decodeImageFromFile, parseImage) invoke this at the
 * sidecar-read entry to fail-fast when an .hdr meta carries srgb.
 */
export function validateColorSpaceForHdr(
  ext: string,
  colorSpace: ImageColorSpace,
): { ok: true; value: ImageColorSpace } | { ok: false; expected: string; actual: string } {
  const lower = ext.toLowerCase();
  if (lower === '.hdr' || lower === '.exr') {
    if (colorSpace !== 'linear') {
      return {
        ok: false,
        expected: 'colorSpace=linear for HDR source files',
        actual: `colorSpace=${colorSpace}`,
      };
    }
    return { ok: true, value: 'linear' };
  }
  return { ok: true, value: colorSpace };
}

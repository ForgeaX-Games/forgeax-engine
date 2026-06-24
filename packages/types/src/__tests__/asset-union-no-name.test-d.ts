// asset-union-no-name.test-d.ts - M1 grep gate for Asset union cardinality
// + POD no-name constraint (OOS-2).
//
// Three assertions guard the SSOT boundary:
// (a) Asset union exhaustive switch covers all 15 kind discriminants
//     without default fallback -- TS compile-error on drift.
// (b) Type-level: exhaustiveSwitch returns string (proves all cases present).
// (c) grep: none of the 15 Asset union member interfaces (MeshAsset /
//     TextureAsset / CubeTextureAsset / SamplerAsset / MaterialAsset /
//     SceneAsset / ShaderAsset / SkeletonAsset / SkinAsset / AnimationClip /
//     AudioClipAsset / FontAsset / RenderPipelineAsset / TilesetAsset /
//     VideoAsset) has gained a `name`
//     field -- only ShaderAsset.name is allowed (registration identifier,
//     orthogonal to resolveName display name per D-8). The check scans
//     each Asset member interface block between `export interface <N>Asset`
//     and the next `}` for `readonly name` and asserts exactly 1 hit
//     (ShaderAsset).
//
// Anchors:
// - requirements OOS-2 (Asset POD shall not carry name)
// - requirements section 6 constraint (Route B: name via resolveName, not POD)
// - plan-strategy D-8 (ShaderAsset.name is orthogonal registration id)
// - plan-tasks w1 acceptanceCheck

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { Asset } from '../index';

const REPO_ROOT = resolve(import.meta.dirname ?? '.', '..', '..', '..', '..');
const TYPES_INDEX = resolve(REPO_ROOT, 'packages', 'types', 'src', 'index.ts');

// Exhaustive switch over Asset.kind -- when a 14th variant is added,
// TS2322 fires on the `_exhaustiveCheck: never` line, blocking the
// PR until this test is updated (charter P4 explicit failure).
function exhaustiveAssetKindSwitch(asset: Asset): string {
  switch (asset.kind) {
    case 'mesh':
      return 'MeshAsset';
    case 'texture':
      return 'TextureAsset';
    case 'cube-texture':
      return 'CubeTextureAsset';
    case 'sampler':
      return 'SamplerAsset';
    case 'material':
      return 'MaterialAsset';
    case 'scene':
      return 'SceneAsset';
    case 'shader':
      return 'ShaderAsset';
    case 'skeleton':
      return 'SkeletonAsset';
    case 'skin':
      return 'SkinAsset';
    case 'animation-clip':
      return 'AnimationClip';
    case 'audio':
      return 'AudioClipAsset';
    case 'font':
      return 'FontAsset';
    case 'render-pipeline':
      return 'RenderPipelineAsset';
    case 'tileset':
      return 'TilesetAsset';
    case 'video':
      return 'VideoAsset';
    default: {
      const _exhaustiveCheck: never = asset;
      return _exhaustiveCheck;
    }
  }
}

// The 14 Asset union member interface names, matching export declarations.
const ASSET_MEMBER_NAMES = [
  'MeshAsset',
  'TextureAsset',
  'CubeTextureAsset',
  'SamplerAsset',
  'MaterialAsset',
  'SceneAsset',
  'ShaderAsset',
  'SkeletonAsset',
  'SkinAsset',
  'AnimationClip',
  'AudioClipAsset',
  'FontAsset',
  'RenderPipelineAsset',
  'TilesetAsset',
  'VideoAsset',
] as const;

/**
 * For each Asset member interface, count `readonly name` field declarations
 * within its interface block. Returns a map from interface name to count.
 *
 * Strategy: for each interface, extract the block between
 * `export interface <Name>` and its matching closing `}` (brace-count
 * method), then grep for `readonly name` within that span.
 */
function countNameFieldsPerAssetInterface(): Map<string, number> {
  const raw = execSync(`cat ${TYPES_INDEX}`, { encoding: 'utf-8' });
  const lines = raw.split('\n');
  const result = new Map<string, number>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    for (const name of ASSET_MEMBER_NAMES) {
      // Match `export interface MeshAsset {` or `export interface AnimationClip {`
      if (line.match(new RegExp(`^export interface ${name} \\{`))) {
        // Walk forward with brace-count until we close this interface.
        let braceDepth = 0;
        let hasOpen = false;
        const blockLines: string[] = [];
        for (let j = i; j < lines.length; j++) {
          const l = lines[j] ?? '';
          blockLines.push(l);
          for (const ch of l) {
            if (ch === '{') {
              braceDepth++;
              hasOpen = true;
            }
            if (ch === '}') {
              braceDepth--;
            }
          }
          if (hasOpen && braceDepth === 0) {
            // Interface block closed.
            const block = blockLines.join('\n');
            const nameCount = (block.match(/\breadonly name\b/g) || []).length;
            result.set(name, nameCount);
            i = j; // continue outer loop from here
            break;
          }
        }
        break;
      }
    }
    i++;
  }
  return result;
}

describe('M1 Asset union cardinality grep gate (15 members, OOS-2 POD no-name)', () => {
  it('(a) exhaustive switch over Asset.kind covers all 15 discriminants', () => {
    const result = exhaustiveAssetKindSwitch({ kind: 'mesh' } as Asset);
    expect(typeof result).toBe('string');
  });

  it('(b) type-level: exhaustive switch returns string (proves all cases)', () => {
    expectTypeOf(exhaustiveAssetKindSwitch).returns.toEqualTypeOf<string>();
  });

  it('(c) no Asset union member interface has a name field except ShaderAsset', () => {
    const counts = countNameFieldsPerAssetInterface();
    expect(counts.size).toBeGreaterThanOrEqual(13);

    for (const [iface, count] of counts) {
      if (iface === 'ShaderAsset') {
        // ShaderAsset.name is allowed (registration identifier, D-8).
        expect(count).toBe(1);
      } else {
        // All other Asset union members must NOT carry a `name` field.
        expect(count).toBe(0);
      }
    }
  });
});

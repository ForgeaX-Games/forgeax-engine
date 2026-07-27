import type { GltfDocItemLike } from './sub-asset-key.js';

export type GltfSourceKeyErrorCode = 'missing-source-key' | 'duplicate-source-key';

export interface GltfSourceKeyError {
  readonly code: GltfSourceKeyErrorCode;
  readonly sourceIndices: readonly number[];
  readonly expected: string;
  readonly hint: string;
}

export type GltfSourceKeyResult =
  | { readonly ok: true; readonly keys: readonly string[]; readonly conflicts: readonly [] }
  | { readonly ok: false; readonly error: GltfSourceKeyError };

/** Derive a semantic glTF key; sourceIndex and source path are never inputs. */
export function sourceKeyForGltfOutput(
  item: Pick<GltfDocItemLike, 'kind' | 'name'>,
): string | undefined {
  if (item.name === undefined || item.name.length === 0) return undefined;
  return `${item.kind}:${item.name}`;
}

/** Require every output in a multi-output declaration to carry a unique key. */
export function deriveGltfSourceKeys(items: readonly GltfDocItemLike[]): GltfSourceKeyResult {
  const keys = items.map((item) => sourceKeyForGltfOutput(item));
  const missing = items
    .map((item, index) => (keys[index] === undefined ? item.sourceIndex : undefined))
    .filter((index): index is number => index !== undefined);
  if (missing.length > 0) {
    return {
      ok: false,
      error: {
        code: 'missing-source-key',
        sourceIndices: missing,
        expected: 'every glTF output needs a stable semantic name',
        hint: 'name the output or return an explicit ambiguous result; do not use sourceIndex',
      },
    };
  }

  const seen = new Map<string, number>();
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index];
    if (key === undefined) continue;
    const prior = seen.get(key);
    if (prior !== undefined) {
      return {
        ok: false,
        error: {
          code: 'duplicate-source-key',
          sourceIndices: [prior, items[index]?.sourceIndex ?? 0],
          expected: 'sourceKey values must be unique within one glTF package',
          hint: 'rename duplicate outputs before publishing topology facts',
        },
      };
    }
    seen.set(key, items[index]?.sourceIndex ?? 0);
  }

  return { ok: true, keys: keys as string[], conflicts: [] };
}

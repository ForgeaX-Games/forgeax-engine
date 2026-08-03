/**
 * Derive the semantic identity for an image producer output.
 *
 * The role is the producer-owned identity. Source path and sourceIndex are
 * locators only and must not be folded into this key.
 */
export interface ImageSourceKeyLocator {
  readonly sourcePath?: string;
  readonly sourceIndex?: number;
}

export type ImageSourceKeyResult =
  | { readonly ok: true; readonly keys: readonly string[] }
  | {
      readonly ok: false;
      readonly code: 'missing-source-key' | 'duplicate-source-key';
      readonly roles: readonly string[];
    };

export function deriveImageSourceKey(
  role: string,
  _locator?: ImageSourceKeyLocator,
): string | undefined {
  const normalizedRole = role.trim();
  if (normalizedRole.length === 0) return undefined;
  return `image:${normalizedRole}`;
}

export function deriveImageSourceKeys(roles: readonly string[]): ImageSourceKeyResult {
  const keys = roles.map((role) => deriveImageSourceKey(role));
  const missing = roles.filter((_role, index) => keys[index] === undefined);
  if (missing.length > 0) return { ok: false, code: 'missing-source-key', roles: missing };

  const seen = new Set<string>();
  for (const key of keys) {
    if (key === undefined) continue;
    if (seen.has(key)) return { ok: false, code: 'duplicate-source-key', roles };
    seen.add(key);
  }
  return { ok: true, keys: keys as string[] };
}

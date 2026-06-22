/**
 * Last path segment of a `/`- or `\`-separated path, trailing separators
 * stripped. Inlined rather than imported from `node:path` so this module stays
 * browser-safe: the dev-server pack path (`vite-plugin-pack` `/__pack/`) runs
 * `buildCatalog` -> `deriveAssetName` in client code where `node:path` is
 * externalized and `path.basename` throws.
 */
function baseName(p: string): string {
  const trimmed = p.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

/**
 * Derive an asset's display name from package metadata.
 *
 * Pure function -- zero IO, zero side effects, browser-safe. Build-time
 * (build-catalog) and runtime (resolveName) share this single source of truth
 * for the XOR name-resolution rules (plan-strategy D-6).
 *
 * Branches:
 *   1. single-asset package (assetCount === 1)      -> baseName(packagePath)
 *   2. multi-asset package + storedName              -> storedName
 *   3. multi-asset package + no storedName (AC-15.1) -> baseName(packagePath)
 *   4. null packagePath + no storedName  (AC-15.2)   -> ''
 */
export function deriveAssetName(
  packagePath: string | null,
  assetCount: number,
  storedName?: string,
): string {
  if (packagePath === null) {
    return storedName ?? '';
  }
  if (assetCount === 1) {
    return baseName(packagePath);
  }
  if (storedName !== undefined) {
    return storedName;
  }
  return baseName(packagePath);
}

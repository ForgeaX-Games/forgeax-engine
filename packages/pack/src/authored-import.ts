import { validateArtifactPath } from './artifact-path.js';
import { validatePack } from './schema-compiled.js';

export interface AuthoredImportAsset {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly refs: readonly string[];
  readonly artifacts?: Readonly<
    Record<
      string,
      {
        readonly path: string;
        readonly byteLength?: number;
        readonly integrity?: { readonly algorithm: 'sha256'; readonly digest: string };
      }
    >
  >;
}

/** Validate author data before publication. Runtime publications are not import sources. */
export function validateAuthoredImport(
  value: unknown,
  availableGuids: ReadonlySet<string> = new Set(),
):
  | {
      readonly ok: true;
      readonly assets: readonly AuthoredImportAsset[];
      readonly artifacts: readonly string[];
    }
  | { readonly ok: false; readonly code: string; readonly hint: string } {
  const fail = (code: string, hint: string) => ({ ok: false as const, code, hint });
  if (!validatePack(value))
    return fail('pack-import-invalid', 'Supply a valid authored internal-text-package.');
  const pack = value as { assets: AuthoredImportAsset[]; [key: string]: unknown };
  if (['scopeId', 'generation', 'digest', 'outputSetDigest'].some((key) => key in pack)) {
    return fail(
      'pack-import-cooked',
      'Import authored Pack source, not a cooked runtime publication.',
    );
  }
  if (pack.assets.length === 0)
    return fail('pack-import-empty', 'Supply at least one authored asset.');
  const ids = new Set<string>();
  for (const asset of pack.assets) {
    const id = asset.guid.toLowerCase();
    if (ids.has(id))
      return fail(
        'pack-guid-collision',
        'Keep each asset GUID unique; do not rewrite identities during import.',
      );
    ids.add(id);
  }
  const available = new Set([...availableGuids].map((guid) => guid.toLowerCase()));
  const artifacts = new Set<string>();
  for (const asset of pack.assets) {
    for (const ref of asset.refs) {
      if (!ids.has(ref.toLowerCase()) && !available.has(ref.toLowerCase())) {
        return fail(
          'pack-import-dependency-missing',
          `Missing asset dependency ${ref}. Import its source in the same batch first.`,
        );
      }
    }
    for (const [key, artifact] of Object.entries(asset.artifacts ?? {})) {
      const checked = validateArtifactPath(artifact.path, {
        packageRoot: '.',
        guid: asset.guid,
        artifactKey: key,
      });
      if (!checked.ok || checked.value !== artifact.path || artifact.path.includes(':')) {
        return fail(
          'pack-import-artifact-path-invalid',
          'Artifact paths must be canonical package-relative paths without URLs or traversal.',
        );
      }
      artifacts.add(checked.value);
    }
  }
  return { ok: true, assets: pack.assets, artifacts: [...artifacts] };
}

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { PackErrorCode } from '@forgeax/engine-types';
import { MATERIAL_PARAM_TYPES, PACK_ERROR_HINTS } from '@forgeax/engine-types';
import { loadAssetConfig } from './config.js';
import { PackError } from './errors.js';
import { resolveAssetSource } from './resolve-asset-source.js';
import { buildMaterialAssetValidator, validateMeta, validatePack } from './schema-compiled.js';

// Minimal Result<T, E> — structurally compatible with @forgeax/engine-rhi Result
// but defined locally to avoid a heavy runtime dep in this build-time package.
export type ScanResult<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

function ok<T>(value: T): ScanResult<T, never> {
  return { ok: true, value };
}

function packErr<E>(error: E): ScanResult<never, E> {
  return { ok: false, error };
}

/**
 * Directory names that are skipped during recursive traversal unless
 * explicitly provided as a root in the `roots` parameter (whitelist override).
 * Requirements §3.4 + §5 blacklist.
 *
 * Re-exported as `SCANNER_BLACKLIST` for cross-package reuse: the
 * `forgeax-engine-remote-asset import --check` traversal (M4 / w21 +
 * plan-strategy section 2.8 path b) walks the same set of source-orphan
 * candidates as the scanner, so we share the single SSOT here.
 */
const BLACKLIST = new Set([
  'node_modules',
  '.forgeax-harness',
  '.git',
  'dist',
  '.forgeax-asset-cache',
  'forgeax-engine-assets',
  'coverage',
]);

export const SCANNER_BLACKLIST: ReadonlySet<string> = BLACKLIST;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidGuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function makePackError(
  code: PackErrorCode,
  detail: ConstructorParameters<typeof PackError>[0]['detail'],
): PackError {
  return new PackError({
    code,
    expected: `pack error: ${code}`,
    hint: PACK_ERROR_HINTS[code],
    detail,
  });
}

/**
 * For scene assets with `payload.mounts[]`, return the lowercased GUID
 * each `mount.source` integer resolves to via `asset.refs[]`. Returns an
 * empty iterable for non-scene assets, scene assets without mounts, or
 * mounts with malformed `source` (out-of-range integer / non-integer) —
 * those are caught by ajv schema validation upstream. The yielded GUIDs
 * feed scanner step-6's mount-asset cycle DFS (D-1, R10).
 */
function* extractMountSourceGuids(asset: {
  kind?: unknown;
  payload?: unknown;
  refs: readonly string[];
}): Generator<string> {
  if (asset.kind !== 'scene') return;
  const payload = asset.payload as { mounts?: unknown } | undefined;
  if (!payload || !Array.isArray(payload.mounts)) return;
  for (const rawMount of payload.mounts) {
    const mount = rawMount as { source?: unknown };
    const idx = mount.source;
    if (typeof idx !== 'number' || !Number.isInteger(idx)) continue;
    if (idx < 0 || idx >= asset.refs.length) continue;
    const resolved = asset.refs[idx];
    if (typeof resolved !== 'string') continue;
    yield resolved.toLowerCase();
  }
}

/**
 * Scan one or more root directories for `.meta.json` and `.pack.json` files.
 * Runs a 7-step fail-fast validation chain (w17 + M7-T01):
 *   Step 1 - collect all .meta.json + .pack.json paths (blacklist skipped)
 *   Step 2 - schema validation (ajv strict)
 *   Step 3 - GUID string format validation
 *   Step 4 - GUID collision detection
 *   Step 5 - orphan .meta.json detection
 *   Step 6 - cyclic reference detection (hand-written DFS)
 *   Step 7 - material-payload-schema-check (buildMaterialAssetValidator for kind='material')
 *
 * Returns `Ok(paths)` or `Err(PackError)` on the first violation.
 *
 * NOTE: source files without a .meta.json are logged but not fatal (requirements §5).
 */
export async function scan(
  roots: readonly string[],
  _opts?: Record<string, unknown>,
): Promise<ScanResult<string[], PackError>> {
  // Step 1: collect all .meta.json and .pack.json paths
  const rawPaths: string[] = [];
  const explicitRootSet = new Set(roots);

  async function traverse(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as import('node:fs').Dirent[];
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        // Skip blacklisted subdirectories unless the subdir is itself an explicit root
        if (BLACKLIST.has(basename(fullPath)) && !explicitRootSet.has(fullPath)) {
          continue;
        }
        await traverse(fullPath);
      } else if (entry.isFile()) {
        const name = entry.name;
        if (name.endsWith('.meta.json') || name.endsWith('.pack.json')) {
          rawPaths.push(fullPath);
        }
      }
    }
  }

  for (const root of roots) {
    await traverse(root);
  }

  // Separate meta and pack paths
  const metaPaths = rawPaths.filter((p) => p.endsWith('.meta.json'));
  const packPaths = rawPaths.filter((p) => p.endsWith('.pack.json'));

  // Step 2 + 3: parse + schema validate + GUID format validate each pack file
  // Collect GUID -> path map for collision detection + refs for cycle detection
  const guidToPackPath = new Map<string, string>();
  const packRefs = new Map<string, string[]>(); // guid -> refs[]

  // Collect material payloads for step-7 validation
  interface MaterialPayloadEntry {
    guid: string;
    payload: unknown;
    path: string;
  }
  const materialPayloads: MaterialPayloadEntry[] = [];

  for (const packPath of packPaths) {
    let parsed: unknown;
    try {
      const raw = await readFile(packPath, 'utf-8');
      parsed = JSON.parse(raw);
    } catch {
      return packErr(
        makePackError('pack-malformed-pack', {
          path: packPath,
          ajvErrors: [{ instancePath: '', message: 'JSON parse failed' }],
        }),
      );
    }

    const valid = validatePack(parsed);
    if (!valid) {
      return packErr(
        makePackError('pack-malformed-pack', {
          path: packPath,
          ajvErrors: (validatePack.errors ?? []).map((e) => ({
            instancePath: e.instancePath,
            message: e.message ?? 'unknown ajv error',
          })),
        }),
      );
    }

    // Step 3: validate GUIDs in pack
    const packObj = parsed as { assets: { guid: string; refs: string[] }[] };
    for (const asset of packObj.assets) {
      if (!isValidGuid(asset.guid)) {
        return packErr(
          makePackError('pack-guid-malformed', {
            raw: asset.guid,
            reason: 'expected 36-char RFC 4122 dash-form UUID',
          }),
        );
      }
      for (const ref of asset.refs) {
        if (!isValidGuid(ref)) {
          return packErr(
            makePackError('pack-guid-malformed', {
              raw: ref,
              reason: 'expected 36-char RFC 4122 dash-form UUID in refs[]',
            }),
          );
        }
      }

      // Step 4: collision check
      const normalizedGuid = asset.guid.toLowerCase();
      const existing = guidToPackPath.get(normalizedGuid);
      if (existing !== undefined) {
        return packErr(
          makePackError('pack-guid-collision', {
            paths: [existing, packPath],
            guid: normalizedGuid,
          }),
        );
      }
      guidToPackPath.set(normalizedGuid, packPath);

      // Accumulate refs for cycle detection
      const existingRefs = packRefs.get(normalizedGuid) ?? [];
      for (const ref of asset.refs) {
        existingRefs.push(ref.toLowerCase());
      }

      // feat-20260608-scene-nesting-ecs-fication M1 / w14 (D-1):
      // mount-payload-extract — for scene assets, redundantly inject the
      // mount.source -> resolved GUID edge into the cycle graph alongside
      // asset.refs[]. By the .pack.json convention mount.source is an
      // integer index into the same asset.refs[], so the resolved GUID is
      // already present in `existingRefs`; this defensive pass guarantees
      // that any author-supplied mounts[] references participate in the
      // cycle DFS even if the schema-emitter forgot to mirror them into
      // refs[]. The `kind: 'mount-asset'` tag on the resulting
      // pack-cyclic-reference detail is set by the cycle producer below
      // (R10).
      for (const guid of extractMountSourceGuids(asset)) {
        existingRefs.push(guid);
      }
      packRefs.set(normalizedGuid, existingRefs);

      // Collect material payloads for step-7 validation.
      // Pass-based (new) payloads carry `passes` + optional `paramValues`.
      // Schema-driven (legacy) payloads carry `materialShader` + `paramSchema` + `paramValues`.
      // Old unlit payloads carry `shadingModel` — these are skipped from step-7
      // since they lack paramSchema for validation, but are still valid assets.
      const assetObj = asset as { kind?: unknown; payload?: unknown };
      if (assetObj.kind === 'material' && assetObj.payload !== undefined) {
        const payload = assetObj.payload as {
          materialShader?: unknown;
          shadingModel?: unknown;
          passes?: unknown;
          paramSchema?: unknown;
        };
        const hasPasses = Array.isArray(payload.passes);
        const isSchemaDriven =
          typeof payload.materialShader === 'string' && Array.isArray(payload.paramSchema);
        if (hasPasses || isSchemaDriven) {
          materialPayloads.push({
            guid: normalizedGuid,
            payload: assetObj.payload,
            path: packPath,
          });
        }
      }
    }
  }

  // Step 2 + 3 + 5: parse + schema validate + GUID format validate + orphan check for meta files
  const { paths: assetPaths } = loadAssetConfig(process.cwd());
  for (const metaPath of metaPaths) {
    let parsed: unknown;
    try {
      const raw = await readFile(metaPath, 'utf-8');
      parsed = JSON.parse(raw);
    } catch {
      return packErr(
        makePackError('pack-malformed-meta', {
          path: metaPath,
          ajvErrors: [{ instancePath: '', message: 'JSON parse failed' }],
        }),
      );
    }

    const valid = validateMeta(parsed);
    if (!valid) {
      return packErr(
        makePackError('pack-malformed-meta', {
          path: metaPath,
          ajvErrors: (validateMeta.errors ?? []).map((e) => ({
            instancePath: e.instancePath,
            message: e.message ?? 'unknown ajv error',
          })),
        }),
      );
    }

    // Step 3: validate GUIDs in meta subAssets
    const metaObj = parsed as {
      source?: string;
      subAssets: { guid: string; sourceIndex: number }[];
    };
    for (const sub of metaObj.subAssets) {
      if (!isValidGuid(sub.guid)) {
        return packErr(
          makePackError('pack-guid-malformed', {
            raw: sub.guid,
            reason: 'expected 36-char RFC 4122 dash-form UUID in subAssets[].guid',
          }),
        );
      }
    }

    // Step 5: orphan .meta.json check — the source file declared in meta.source must exist.
    // Uses resolveAssetSource for three-mode dispatch (undefined derivation / @name/ path table /
    // relative path), replacing the former hardcoded join(metaDir, metaObj.source).
    const sourceResolved = resolveAssetSource(metaPath, metaObj.source, assetPaths);
    if (!sourceResolved.ok) {
      return packErr(sourceResolved.error);
    }
    const expectedSourcePath = sourceResolved.value;
    try {
      await stat(expectedSourcePath);
    } catch {
      return packErr(
        makePackError('pack-orphan-meta', {
          metaPath,
          expectedFile: expectedSourcePath,
        }),
      );
    }
  }

  // Step 6: cyclic reference detection via hand-written DFS (no graphlib dep)
  // visited: nodes fully processed; recStack: nodes in current DFS path
  const visited = new Set<string>();
  const recStack = new Set<string>();

  function dfs(guid: string, path: string[]): string[] | null {
    visited.add(guid);
    recStack.add(guid);

    for (const ref of packRefs.get(guid) ?? []) {
      if (!visited.has(ref)) {
        const cycle = dfs(ref, [...path, ref]);
        if (cycle !== null) return cycle;
      } else if (recStack.has(ref)) {
        // Found a back-edge: reconstruct cycle from the repeated node
        const cycleStart = path.indexOf(ref);
        return cycleStart >= 0 ? [...path.slice(cycleStart), ref] : [...path, ref];
      }
    }

    recStack.delete(guid);
    return null;
  }

  for (const guid of guidToPackPath.keys()) {
    if (!visited.has(guid)) {
      const cycle = dfs(guid, [guid]);
      if (cycle !== null) {
        return packErr(
          makePackError('pack-cyclic-reference', {
            code: 'pack-cyclic-reference',
            kind: 'mount-asset',
            cycle,
          }),
        );
      }
    }
  }

  // Step 7: material-payload-schema-check (schema-driven payloads only)
  if (materialPayloads.length > 0) {
    const validateMaterialPayload = buildMaterialAssetValidator(new Set(MATERIAL_PARAM_TYPES));
    for (const entry of materialPayloads) {
      const p = entry.payload as { passes?: unknown; materialShader?: unknown };
      if (Array.isArray(p.passes)) continue;
      const valid = validateMaterialPayload(entry.payload);
      if (!valid) {
        return packErr(
          makePackError('payload-schema-mismatch', {
            code: 'payload-schema-mismatch' as const,
            guid: entry.guid,
            errors: (validateMaterialPayload.errors ?? []).map((e) => ({
              instancePath: e.instancePath,
              message: e.message ?? 'unknown ajv error',
            })),
          }),
        );
      }
    }
  }

  return ok(rawPaths);
}

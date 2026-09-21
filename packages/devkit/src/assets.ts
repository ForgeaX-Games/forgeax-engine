import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { runCliGltf } from '@forgeax/engine-gltf/cli-gltf';
import { validateAuthoredImport } from '@forgeax/engine-pack';
import { scanEntries } from '@forgeax/engine-pack/cli-asset';
import { AssetGuid } from '@forgeax/engine-pack/guid';
import { commandError, readProjectFacts } from './project.js';
import type {
  AssetAddOptions,
  AssetInspectOptions,
  CommandError,
  CommandResult,
  ProjectCommandOptions,
} from './types.js';

const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.hdr']);
const gltfExtensions = new Set(['.gltf', '.glb']);

function failure(error: CommandError): CommandResult<never> {
  return { ok: false, error };
}

async function sourcesAt(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  if (!info.isDirectory()) return [];
  const output: string[] = [];
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist')
      continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) output.push(...(await sourcesAt(child)));
    else if (entry.isFile() && !entry.name.endsWith('.meta.json')) output.push(child);
  }
  return output;
}

async function addImage(sourcePath: string, dryRun: boolean): Promise<CommandResult<unknown>> {
  const metaPath = `${sourcePath}.meta.json`;
  const source = basename(sourcePath);
  let existing: unknown;
  try {
    existing = JSON.parse(await readFile(metaPath, 'utf8')) as unknown;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
      return failure({
        code: 'asset-meta-unreadable',
        expected: 'an absent or readable JSON sidecar',
        hint: 'Repair the existing sidecar before adding the source again.',
        detail: { source: sourcePath, metaPath },
      });
    }
  }
  if (existing !== undefined) {
    const value = existing as {
      importer?: unknown;
      source?: unknown;
      subAssets?: readonly { guid?: unknown; kind?: unknown }[];
    };
    const row = value.subAssets?.[0];
    if (
      value.importer !== 'image' ||
      value.source !== source ||
      value.subAssets?.length !== 1 ||
      typeof row?.guid !== 'string' ||
      row.kind !== 'texture'
    ) {
      return failure({
        code: 'asset-meta-conflict',
        expected: 'the existing sidecar to describe this image source and one texture identity',
        hint: 'Resolve the sidecar conflict explicitly; DevKit will not replace authored identity.',
        detail: { source: sourcePath, metaPath },
      });
    }
    return { ok: true, value: { source: sourcePath, metaPath, guid: row.guid, reused: true } };
  }
  const guid = AssetGuid.format(AssetGuid.random());
  const linear = extname(sourcePath).toLowerCase() === '.hdr';
  const meta = {
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source,
    importSettings: {
      colorSpace: linear ? 'linear' : 'srgb',
      mipmap: true,
      addressMode: 'repeat',
      filterMode: 'linear',
    },
    subAssets: [{ guid, sourceIndex: 0, kind: 'texture', sourceKey: 'texture' }],
  } as const;
  if (!dryRun) await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { flag: 'wx' });
  return { ok: true, value: { source: sourcePath, metaPath, guid, reused: false, dryRun } };
}

async function addGltf(sourcePath: string, dryRun: boolean): Promise<CommandResult<unknown>> {
  if (dryRun) {
    const exists = await stat(`${sourcePath}.meta.json`)
      .then(() => true)
      .catch(() => false);
    return {
      ok: true,
      value: {
        source: sourcePath,
        metaPath: `${sourcePath}.meta.json`,
        reused: exists,
        dryRun: true,
      },
    };
  }
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runCliGltf(['import', sourcePath], {
    stdoutWrite: (line) => stdout.push(line),
    stderrWrite: (line) => stderr.push(line),
  });
  if (exitCode !== 0) {
    try {
      return failure(JSON.parse(stderr.at(-1) ?? '') as CommandError);
    } catch {
      return failure({
        code: 'asset-add-failed',
        expected: 'the glTF producer to create or reuse a valid sidecar',
        hint: 'Inspect the glTF source and its external references.',
        detail: { source: sourcePath, diagnostic: stderr.join('\n') },
      });
    }
  }
  return { ok: true, value: { source: sourcePath, metaPath: `${sourcePath}.meta.json` } };
}

async function addAuthoredPacks(
  root: string,
  assetRoots: readonly string[],
  sources: readonly string[],
) {
  if (sources.length === 0) return { ok: true as const, value: [] as unknown[] };
  const scanned = await scanEntries(
    assetRoots.map((path) => resolve(root, path)),
    {
      stdoutWrite() {},
      stderrWrite() {},
    },
  );
  if (!scanned.ok)
    return failure({
      code: 'pack-import-catalog-invalid',
      detail: { sources },
      expected: 'a collision-free project catalog',
      hint: 'Repair the Pack scanner error before importing.',
    });
  const available = new Set(scanned.value.map((entry) => entry.guid.toLowerCase()));
  const canonicalRoots = await Promise.all(
    assetRoots.map((path) => realpath(resolve(root, path)).catch(() => null)),
  );
  const contained = (base: string, path: string) => {
    const rel = relative(base, path);
    return rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel);
  };
  const assets: unknown[] = [];
  for (const source of sources) {
    const canonical = await realpath(source);
    if (
      (await lstat(source)).isSymbolicLink() ||
      !canonicalRoots.some((path) => path !== null && contained(path, canonical))
    )
      return failure({
        code: 'pack-import-source-escape',
        detail: { source },
        expected: 'Pack source in a configured asset root',
        hint: 'Stage the complete source package inside the game asset roots.',
      });
    const parsed = JSON.parse(await readFile(source, 'utf8'));
    const checked = validateAuthoredImport(parsed, available);
    if (!checked.ok)
      return failure({
        code: checked.code,
        detail: { source },
        expected: 'a complete authored Pack',
        hint: checked.hint,
      });
    const base = await realpath(dirname(source));
    for (const artifact of checked.artifacts) {
      const target = resolve(base, artifact);
      let canonicalArtifact: string;
      try {
        canonicalArtifact = await realpath(target);
      } catch {
        return failure({
          code: 'pack-import-artifact-missing',
          expected: 'all declared artifact files',
          hint: 'Include the complete relative dependency tree.',
          detail: { artifact },
        });
      }
      if (
        !contained(base, canonicalArtifact) ||
        canonicalArtifact !== target ||
        !(await stat(target)).isFile()
      ) {
        return failure({
          code: 'pack-import-artifact-path-invalid',
          detail: { source, artifact },
          expected: 'regular files confined to the source package',
          hint: 'Remove unsafe artifact paths.',
        });
      }
      const bytes = await readFile(target);
      const descriptors = checked.assets
        .flatMap((asset) => Object.values(asset.artifacts ?? {}))
        .filter((entry) => entry.path === artifact);
      if (
        descriptors.some(
          (entry) =>
            (entry.byteLength !== undefined && entry.byteLength !== bytes.byteLength) ||
            (entry.integrity !== undefined &&
              entry.integrity.digest !== createHash('sha256').update(bytes).digest('hex')),
        )
      ) {
        return failure({
          code: 'pack-import-artifact-integrity',
          detail: { source, artifact },
          expected: 'artifact bytes matching their declared size and digest',
          hint: 'Restore the declared source artifact; do not rewrite the Pack identity.',
        });
      }
    }
    assets.push({
      source,
      subAssets: checked.assets.map((asset) => ({
        guid: asset.guid,
        kind: asset.kind,
        ...(asset.name ? { name: asset.name } : {}),
      })),
      reused: true,
    });
  }
  return { ok: true as const, value: assets };
}

export async function assetAddCommand(options: AssetAddOptions): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const target = resolve(facts.value.root, options.path);
  try {
    const sources = await sourcesAt(target);
    const supported = sources.filter((source) => {
      const extension = extname(source).toLowerCase();
      return (
        imageExtensions.has(extension) ||
        gltfExtensions.has(extension) ||
        source.toLowerCase().endsWith('.pack.json')
      );
    });
    if (supported.length === 0) {
      return failure({
        code: 'source-package-importer-missing',
        expected: 'an authored .pack.json, .png, .jpg, .jpeg, .hdr, .gltf, or .glb source',
        hint: 'Use a supported built-in importer or add an explicit producer before adding this source.',
        detail: { target },
      });
    }
    const packSources = supported.filter((source) => source.toLowerCase().endsWith('.pack.json'));
    const packs = await addAuthoredPacks(facts.value.root, facts.value.assetRoots, packSources);
    if (!packs.ok) return packs;
    const assets: unknown[] = [...packs.value];
    for (const source of supported.filter((source) => !packSources.includes(source))) {
      const result = imageExtensions.has(extname(source).toLowerCase())
        ? await addImage(source, options.dryRun === true)
        : await addGltf(source, options.dryRun === true);
      if (!result.ok) return result;
      assets.push(result.value);
    }
    return { ok: true, value: { root: facts.value.root, assets, dryRun: options.dryRun === true } };
  } catch (cause) {
    return failure(commandError(cause, 'asset-add-failed'));
  }
}

async function entries(options: ProjectCommandOptions) {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await scanEntries(
    facts.value.assetRoots.map((root) => resolve(facts.value.root, root)),
    { stdoutWrite: (line) => stdout.push(line), stderrWrite: (line) => stderr.push(line) },
  );
  if (!result.ok) {
    try {
      return failure(JSON.parse(stderr.at(-1) ?? '') as CommandError);
    } catch {
      return failure({
        code: 'asset-authority-invalid',
        expected: 'all asset roots and sidecars to pass the pack scanner',
        hint: 'Repair the first invalid asset authority reported by the scanner.',
        detail: { diagnostic: stderr.join('\n') },
      });
    }
  }
  return { ok: true as const, value: { facts: facts.value, entries: result.value } };
}

export async function assetListCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  const result = await entries(options);
  if (!result.ok) return result;
  return { ok: true, value: result.value.entries };
}

export async function assetVerifyCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<unknown>> {
  const result = await entries(options);
  if (!result.ok) return result;
  return {
    ok: true,
    value: { root: result.value.facts.root, assetCount: result.value.entries.length },
  };
}

export async function assetInspectCommand(
  options: AssetInspectOptions,
): Promise<CommandResult<unknown>> {
  const result = await entries(options);
  if (!result.ok) return result;
  const subject = options.subject.toLowerCase();
  const matches = result.value.entries.filter(
    (entry) => entry.guid.toLowerCase() === subject || entry.name?.toLowerCase() === subject,
  );
  if (matches.length !== 1) {
    return failure({
      code: matches.length === 0 ? 'asset-not-found' : 'asset-subject-ambiguous',
      expected: 'the GUID or name to resolve to exactly one asset',
      hint:
        matches.length === 0
          ? 'Run asset list and choose a known subject.'
          : 'Use the stable GUID.',
      detail: { subject: options.subject, matches },
    });
  }
  return { ok: true, value: matches[0] };
}

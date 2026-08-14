import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import { runCliGltf } from '@forgeax/engine-gltf/cli-gltf';
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

export async function assetAddCommand(options: AssetAddOptions): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const target = resolve(facts.value.root, options.path);
  try {
    const sources = await sourcesAt(target);
    const supported = sources.filter((source) => {
      const extension = extname(source).toLowerCase();
      return imageExtensions.has(extension) || gltfExtensions.has(extension);
    });
    if (supported.length === 0) {
      return failure({
        code: 'source-package-importer-missing',
        expected: 'a .png, .jpg, .jpeg, .hdr, .gltf, or .glb source',
        hint: 'Use a supported built-in importer or add an explicit producer before adding this source.',
        detail: { target },
      });
    }
    const assets: unknown[] = [];
    for (const source of supported) {
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

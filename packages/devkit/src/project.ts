import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { CommandError, CommandResult, ProjectFacts } from './types.js';

interface ForgeManifest {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly entry?: unknown;
  readonly physics?: unknown;
  readonly defaultScene?: unknown;
}

function projectError(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>>,
): CommandResult<never> {
  return { ok: false, error: { code, expected, hint, detail } };
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function readProjectFacts(
  rootInput = process.cwd(),
): Promise<CommandResult<ProjectFacts>> {
  const root = resolve(rootInput);
  let forgeValue: unknown;
  let packageValue: unknown;
  try {
    [forgeValue, packageValue] = await Promise.all([
      readJson(resolve(root, 'forge.json')),
      readJson(resolve(root, 'package.json')),
    ]);
  } catch (cause) {
    return projectError(
      'project-manifest-unreadable',
      'readable forge.json and package.json files',
      'Run the command from a ForgeaX game root or pass its directory.',
      { root, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
  if (forgeValue === null || typeof forgeValue !== 'object') {
    return projectError(
      'project-manifest-invalid',
      'forge.json to contain an object',
      'Repair forge.json before running DevKit.',
      { root },
    );
  }
  if (packageValue === null || typeof packageValue !== 'object') {
    return projectError(
      'package-manifest-invalid',
      'package.json to contain an object',
      'Repair package.json before running DevKit.',
      { root },
    );
  }
  const forge = forgeValue as ForgeManifest;
  if (
    typeof forge.id !== 'string' ||
    forge.id.length === 0 ||
    typeof forge.name !== 'string' ||
    forge.name.length === 0 ||
    typeof forge.entry !== 'string' ||
    forge.entry.length === 0
  ) {
    return projectError(
      'project-manifest-invalid',
      'forge.json to declare non-empty id, name, and entry strings',
      'Repair the project facts in forge.json.',
      { root },
    );
  }
  const entryPath = isAbsolute(forge.entry) ? forge.entry : resolve(root, forge.entry);
  try {
    await readFile(entryPath);
  } catch {
    return projectError(
      'project-entry-missing',
      'forge.json#entry to resolve to a readable module',
      'Restore the game entry or update forge.json#entry.',
      { root, entry: forge.entry },
    );
  }
  const packageJson = packageValue as Record<string, unknown>;
  const forgeax = packageJson.forgeax;
  const configuredRoots =
    forgeax !== null && typeof forgeax === 'object'
      ? (forgeax as { assets?: { roots?: unknown } }).assets?.roots
      : undefined;
  const assetRoots =
    Array.isArray(configuredRoots) && configuredRoots.every((value) => typeof value === 'string')
      ? configuredRoots
      : ['assets'];
  const physics = forge.physics === '2d' || forge.physics === '3d' ? forge.physics : undefined;
  const defaultScene =
    typeof forge.defaultScene === 'string' && forge.defaultScene.length > 0
      ? forge.defaultScene
      : undefined;
  return {
    ok: true,
    value: {
      root,
      id: forge.id,
      name: forge.name,
      entry: forge.entry,
      ...(physics === undefined ? {} : { physics }),
      ...(defaultScene === undefined ? {} : { defaultScene }),
      assetRoots,
      packageJson,
    },
  };
}

export function commandError(cause: unknown, fallbackCode: string): CommandError {
  if (
    cause !== null &&
    typeof cause === 'object' &&
    'code' in cause &&
    'expected' in cause &&
    'hint' in cause &&
    'detail' in cause
  ) {
    return cause as CommandError;
  }
  return {
    code: fallbackCode,
    expected: 'the ForgeaX command to complete',
    hint: 'Inspect the underlying diagnostic and repair the owning input.',
    detail: { reason: cause instanceof Error ? cause.message : String(cause) },
  };
}

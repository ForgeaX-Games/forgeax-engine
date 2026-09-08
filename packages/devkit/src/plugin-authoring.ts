import { execFile } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { type GameProjectPluginEntry, GameProjectSchema } from '@forgeax/engine-project';
import type { CommandResult, PluginInstallOptions, PluginUninstallOptions } from './types.js';

const execFileAsync = promisify(execFile);

async function readManifest(root: string): Promise<CommandResult<{ raw: string; value: unknown }>> {
  const path = resolve(root, 'forge.json');
  try {
    const raw = await readFile(path, 'utf8');
    return { ok: true, value: { raw, value: JSON.parse(raw) as unknown } };
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'plugin-manifest-unreadable',
        expected: 'a readable forge.json',
        hint: 'Repair the project manifest before changing plugin installation state.',
        detail: { path, reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
}

async function writeManifest(root: string, value: unknown): Promise<void> {
  const path = resolve(root, 'forge.json');
  const temporary = resolve(root, `.forgeax-plugin-${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  try {
    await rename(temporary, path);
  } catch (cause) {
    await unlink(temporary).catch(() => undefined);
    throw cause;
  }
}

function allEntries(entries: readonly GameProjectPluginEntry[]): GameProjectPluginEntry[] {
  return entries.flatMap((entry) => [
    entry,
    ...(entry.group === true ? allEntries(entry.config as readonly GameProjectPluginEntry[]) : []),
  ]);
}

function withoutEntry(
  entries: readonly GameProjectPluginEntry[],
  id: string,
): GameProjectPluginEntry[] {
  return entries.flatMap((entry) => {
    if (entry.id === id) return [];
    if (entry.group !== true) return [entry];
    return [
      {
        ...entry,
        config: withoutEntry(entry.config as readonly GameProjectPluginEntry[], id),
      },
    ];
  });
}

async function mutateDependency(
  root: string,
  action: 'add' | 'remove',
  dependency: string | undefined,
): Promise<void> {
  if (dependency === undefined) return;
  await execFileAsync('pnpm', [action, dependency], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
}

export async function pluginInstallCommand(
  options: PluginInstallOptions,
): Promise<CommandResult<unknown>> {
  const root = resolve(options.root ?? process.cwd());
  const manifest = await readManifest(root);
  if (!manifest.ok) return manifest;
  const parsed = GameProjectSchema.safeParse(manifest.value.value);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'plugin-manifest-invalid',
        expected: 'forge.json to satisfy GameProjectSchema',
        hint: 'Repair the manifest before installing a plugin.',
        detail: { issues: parsed.error.issues },
      },
    };
  }
  const entries = parsed.data.plugins ?? [];
  if (allEntries(entries).some((entry) => entry.id === options.id)) {
    return {
      ok: false,
      error: {
        code: 'plugin-entry-id-conflict',
        expected: 'a project-unique plugin Entry id',
        hint: 'Choose a stable id not already present in forge.json#plugins.',
        detail: { id: options.id },
      },
    };
  }
  const next = {
    ...parsed.data,
    plugins: [
      ...entries,
      { id: options.id, name: options.module, realm: options.realm ?? 'engine' },
    ],
  };
  if (options.dryRun === true) return { ok: true, value: { root, manifest: next } };
  try {
    await writeManifest(root, next);
    await mutateDependency(root, 'add', options.dependency);
    return { ok: true, value: { root, id: options.id, module: options.module } };
  } catch (cause) {
    await writeFile(resolve(root, 'forge.json'), manifest.value.raw);
    return {
      ok: false,
      error: {
        code: 'plugin-install-failed',
        expected: 'dependency and forge.json Entry mutations to commit together',
        hint: 'Inspect the package-manager failure; the original forge.json was restored.',
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
}

export async function pluginUninstallCommand(
  options: PluginUninstallOptions,
): Promise<CommandResult<unknown>> {
  const root = resolve(options.root ?? process.cwd());
  const manifest = await readManifest(root);
  if (!manifest.ok) return manifest;
  const parsed = GameProjectSchema.safeParse(manifest.value.value);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        code: 'plugin-manifest-invalid',
        expected: 'forge.json to satisfy GameProjectSchema',
        hint: 'Repair the manifest before uninstalling a plugin.',
        detail: { issues: parsed.error.issues },
      },
    };
  }
  const entries = parsed.data.plugins ?? [];
  if (!allEntries(entries).some((entry) => entry.id === options.id)) {
    return {
      ok: false,
      error: {
        code: 'plugin-entry-missing',
        expected: 'the plugin Entry id to exist',
        hint: 'Inspect forge.json#plugins and pass an installed Entry id.',
        detail: { id: options.id },
      },
    };
  }
  const next = { ...parsed.data, plugins: withoutEntry(entries, options.id) };
  if (options.dryRun === true) return { ok: true, value: { root, manifest: next } };
  try {
    await writeManifest(root, next);
    await mutateDependency(root, 'remove', options.dependency);
    return { ok: true, value: { root, id: options.id } };
  } catch (cause) {
    await writeFile(resolve(root, 'forge.json'), manifest.value.raw);
    return {
      ok: false,
      error: {
        code: 'plugin-uninstall-failed',
        expected: 'Entry and dependency removal to commit together',
        hint: 'Inspect the package-manager failure; the original forge.json was restored.',
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
}

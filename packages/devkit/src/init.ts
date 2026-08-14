import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import devkitPackage from '../package.json' with { type: 'json' };
import type { SdkManifest } from './sdk.js';
import type { CommandResult, InitOptions, ProjectFacts } from './types.js';

const STANDARD_SCRIPTS = {
  dev: 'forgeax dev',
  build: 'forgeax build',
  preview: 'forgeax preview',
  doctor: 'forgeax doctor',
  test: 'forgeax test',
} as const;

export interface InitPlan {
  readonly root: string;
  readonly version: string;
  readonly archiveBacked: boolean;
  readonly dependencyChanges: readonly {
    readonly section: string;
    readonly name: string;
    readonly from?: string;
    readonly to: string;
  }[];
  readonly scriptChanges: readonly { readonly name: string; readonly to: string }[];
}

export function createInitPlan(
  facts: ProjectFacts,
  sdk?: Pick<SdkManifest, 'sdkVersion' | 'packages'>,
): CommandResult<InitPlan> {
  const manifest = structuredClone(facts.packageJson) as Record<string, unknown>;
  const packageVersions = new Map(sdk?.packages.map((entry) => [entry.name, entry.version]));
  const devkitVersion = packageVersions.get('@forgeax/engine-devkit') ?? devkitPackage.version;
  const dependencyChanges: InitPlan['dependencyChanges'][number][] = [];
  if (sdk !== undefined) {
    for (const section of ['dependencies', 'devDependencies'] as const) {
      const dependencies = manifest[section];
      if (dependencies === null || typeof dependencies !== 'object') continue;
      const unsupported = Object.keys(dependencies).filter(
        (name) =>
          !name.startsWith('@forgeax/engine-') &&
          name !== '@webgpu/types' &&
          name !== 'tsx' &&
          name !== 'vitest',
      );
      if (unsupported.length > 0) {
        return {
          ok: false,
          error: {
            code: 'sdk-external-dependency-unsupported',
            expected: 'archive-backed init dependencies to belong to the SDK closure',
            hint: 'Remove the external dependency or use a network-backed package workflow explicitly.',
            detail: { root: facts.root, dependencies: unsupported.sort() },
          },
        };
      }
    }
  }
  for (const section of ['dependencies', 'devDependencies'] as const) {
    const dependencies = manifest[section];
    if (dependencies === null || typeof dependencies !== 'object') continue;
    for (const [name, value] of Object.entries(dependencies)) {
      if (
        name.startsWith('@forgeax/engine-') &&
        typeof value === 'string' &&
        value.startsWith('workspace:')
      ) {
        const version = packageVersions.get(name) ?? devkitVersion;
        dependencyChanges.push({ section, name, from: value, to: version });
      }
    }
  }
  if (sdk !== undefined) {
    const existingEngineNames = new Set(
      ['dependencies', 'devDependencies'].flatMap((section) => {
        const value = manifest[section];
        return value !== null && typeof value === 'object'
          ? Object.keys(value).filter((name) => name.startsWith('@forgeax/engine-'))
          : [];
      }),
    );
    for (const entry of sdk.packages) {
      if (entry.name === '@forgeax/engine-devkit' || existingEngineNames.has(entry.name)) continue;
      dependencyChanges.push({
        section: 'dependencies',
        name: entry.name,
        to: entry.version,
      });
    }
    const devDependencies =
      manifest.devDependencies !== null && typeof manifest.devDependencies === 'object'
        ? (manifest.devDependencies as Record<string, unknown>)
        : {};
    if (devDependencies['@webgpu/types'] !== '0.1.71') {
      dependencyChanges.push({
        section: 'devDependencies',
        name: '@webgpu/types',
        ...(typeof devDependencies['@webgpu/types'] === 'string'
          ? { from: devDependencies['@webgpu/types'] }
          : {}),
        to: '0.1.71',
      });
    }
    if (devDependencies.vitest !== '4.1.5') {
      dependencyChanges.push({
        section: 'devDependencies',
        name: 'vitest',
        ...(typeof devDependencies.vitest === 'string' ? { from: devDependencies.vitest } : {}),
        to: '4.1.5',
      });
    }
    if (devDependencies.tsx !== '4.23.1') {
      dependencyChanges.push({
        section: 'devDependencies',
        name: 'tsx',
        ...(typeof devDependencies.tsx === 'string' ? { from: devDependencies.tsx } : {}),
        to: '4.23.1',
      });
    }
  }
  const scriptsValue = manifest.scripts;
  const scripts =
    scriptsValue !== null && typeof scriptsValue === 'object'
      ? (scriptsValue as Record<string, unknown>)
      : {};
  const scriptChanges: InitPlan['scriptChanges'][number][] = [];
  for (const [name, command] of Object.entries(STANDARD_SCRIPTS)) {
    const existing = scripts[name];
    if (existing === undefined) scriptChanges.push({ name, to: command });
    else if (existing !== command) {
      return {
        ok: false,
        error: {
          code: 'project-script-conflict',
          expected: `package.json#scripts.${name} to be absent or ${JSON.stringify(command)}`,
          hint: `Rename the existing ${name} script, then rerun forgeax init.`,
          detail: { root: facts.root, script: name, existing },
        },
      };
    }
  }
  const devDependencies = manifest.devDependencies;
  const existingDevkit =
    devDependencies !== null && typeof devDependencies === 'object'
      ? (devDependencies as Record<string, unknown>)['@forgeax/engine-devkit']
      : undefined;
  if (existingDevkit !== devkitVersion) {
    dependencyChanges.push({
      section: 'devDependencies',
      name: '@forgeax/engine-devkit',
      ...(typeof existingDevkit === 'string' ? { from: existingDevkit } : {}),
      to: devkitVersion,
    });
  }
  return {
    ok: true,
    value: {
      root: facts.root,
      version: sdk?.sdkVersion ?? devkitVersion,
      archiveBacked: sdk !== undefined,
      dependencyChanges,
      scriptChanges,
    },
  };
}

export async function applyInitPlan(
  facts: ProjectFacts,
  plan: InitPlan,
  options: InitOptions,
): Promise<CommandResult<InitPlan>> {
  if (options.dryRun === true) return { ok: true, value: plan };
  const manifest = structuredClone(facts.packageJson) as Record<string, unknown>;
  for (const change of plan.dependencyChanges) {
    const sectionValue = manifest[change.section];
    const section =
      sectionValue !== null && typeof sectionValue === 'object'
        ? (sectionValue as Record<string, unknown>)
        : {};
    section[change.name] = change.to;
    manifest[change.section] = section;
  }
  const scriptsValue = manifest.scripts;
  const scripts =
    scriptsValue !== null && typeof scriptsValue === 'object'
      ? (scriptsValue as Record<string, unknown>)
      : {};
  for (const change of plan.scriptChanges) scripts[change.name] = change.to;
  manifest.scripts = scripts;
  if (plan.archiveBacked) {
    manifest.packageManager = 'pnpm@10.33.2';
    manifest.pnpm = {
      onlyBuiltDependencies: [
        '@forgeax/engine-codec',
        '@forgeax/engine-fbx',
        '@forgeax/engine-wgpu-wasm',
        'esbuild',
      ],
    };
  }
  await writeFile(resolve(facts.root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, value: plan };
}

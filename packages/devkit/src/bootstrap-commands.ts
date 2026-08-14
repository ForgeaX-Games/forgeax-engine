import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { applyInitPlan, createInitPlan } from './init.js';
import { commandError, readProjectFacts } from './project.js';
import { findSdkContext } from './sdk.js';
import type { CommandResult, InitOptions, NewOptions, ProjectCommandOptions } from './types.js';

const execFileAsync = promisify(execFile);

export interface DoctorReport {
  readonly root: string;
  readonly projectId: string;
  readonly node: string;
  readonly pnpm: string;
  readonly workspaceDependencies: readonly string[];
}

function nodeSupported(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 13);
}

function pnpmSupported(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major === 10 && minor >= 33;
}

export async function doctorCommand(
  options: ProjectCommandOptions = {},
): Promise<CommandResult<DoctorReport>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  let pnpm: string;
  try {
    pnpm = (await execFileAsync('pnpm', ['--version'], { cwd: facts.value.root })).stdout.trim();
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'pnpm-unavailable',
        expected: 'pnpm to be available on PATH',
        hint: 'Install the SDK-supported pnpm version and retry.',
        detail: { reason: cause instanceof Error ? cause.message : String(cause) },
      },
    };
  }
  if (!nodeSupported()) {
    return {
      ok: false,
      error: {
        code: 'node-version-unsupported',
        expected: 'Node.js >=22.13.0',
        hint: 'Select a supported Node.js installation and retry.',
        detail: { actual: process.versions.node },
      },
    };
  }
  if (!pnpmSupported(pnpm)) {
    return {
      ok: false,
      error: {
        code: 'pnpm-version-unsupported',
        expected: 'pnpm >=10.33.0 <11',
        hint: 'Enable the packageManager-declared pnpm version with Corepack and retry.',
        detail: { actual: pnpm },
      },
    };
  }
  const workspaceDependencies: string[] = [];
  for (const section of ['dependencies', 'devDependencies']) {
    const value = facts.value.packageJson[section];
    if (value === null || typeof value !== 'object') continue;
    for (const [name, version] of Object.entries(value)) {
      if (
        typeof version === 'string' &&
        (version.startsWith('workspace:') || version.startsWith('file:'))
      ) {
        workspaceDependencies.push(name);
      }
    }
  }
  if (workspaceDependencies.length > 0) {
    return {
      ok: false,
      error: {
        code: 'project-local-dependency',
        expected: 'all external project dependencies to use SDK-resolved exact versions',
        hint: 'Run forgeax init from the unpacked SDK and commit the resulting lockfile.',
        detail: { dependencies: workspaceDependencies.sort() },
      },
    };
  }
  return {
    ok: true,
    value: {
      root: facts.value.root,
      projectId: facts.value.id,
      node: process.versions.node,
      pnpm,
      workspaceDependencies,
    },
  };
}

export async function initCommand(options: InitOptions = {}): Promise<CommandResult<unknown>> {
  const facts = await readProjectFacts(options.root);
  if (!facts.ok) return facts;
  const sdk = await findSdkContext();
  const plan = createInitPlan(facts.value, sdk?.manifest);
  if (!plan.ok) return plan;
  try {
    const applied = await applyInitPlan(facts.value, plan.value, options);
    if (!applied.ok || options.dryRun === true) return applied;
    if (sdk !== undefined) {
      await copyFile(
        resolve(sdk.template, 'pnpm-lock.yaml'),
        resolve(facts.value.root, 'pnpm-lock.yaml'),
      );
    }
    if (options.install === false) return applied;
    const installArgs =
      sdk === undefined
        ? ['install', '--frozen-lockfile=false']
        : ['install', '--offline', '--frozen-lockfile', '--store-dir', sdk.store];
    await execFileAsync('pnpm', installArgs, {
      cwd: facts.value.root,
      maxBuffer: 16 * 1024 * 1024,
    });
    return applied;
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-init-failed') };
  }
}

export async function newCommand(options: NewOptions = {}): Promise<CommandResult<unknown>> {
  const sdk = await findSdkContext();
  if (sdk === undefined) {
    return {
      ok: false,
      error: {
        code: 'sdk-context-missing',
        expected: 'forgeax new to run from an unpacked ForgeaX SDK',
        hint: 'Run the SDK archive bin/forgeax.mjs entry or set FORGEAX_SDK_ROOT.',
        detail: {},
      },
    };
  }
  const root = resolve(options.root ?? process.cwd());
  try {
    let targetExists = true;
    const entries = await readdir(root).catch(() => {
      targetExists = false;
      return [];
    });
    if (entries.length > 0) {
      return {
        ok: false,
        error: {
          code: 'project-target-not-empty',
          expected: 'forgeax new target to be absent or empty',
          hint: 'Choose an empty directory so existing files cannot be overwritten.',
          detail: { root },
        },
      };
    }
    if (options.dryRun === true) {
      return {
        ok: true,
        value: { root, template: sdk.template, sdkVersion: sdk.manifest.sdkVersion },
      };
    }
    if (!targetExists) {
      await mkdir(resolve(root, '..'), { recursive: true });
      await cp(sdk.template, root, { recursive: true, errorOnExist: true, force: false });
    } else {
      for (const name of await readdir(sdk.template)) {
        await cp(resolve(sdk.template, name), resolve(root, name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
    }
    await execFileAsync(
      'pnpm',
      ['install', '--offline', '--frozen-lockfile', '--store-dir', sdk.store],
      { cwd: root, maxBuffer: 16 * 1024 * 1024 },
    );
    return { ok: true, value: { root, sdkVersion: sdk.manifest.sdkVersion } };
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-create-failed') };
  }
}

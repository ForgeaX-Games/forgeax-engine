import { execFile } from 'node:child_process';
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { applyInitPlan, createInitPlan } from './init.js';
import { commandError, readProjectFacts } from './project.js';
import { findSdkContext } from './sdk.js';
import {
  agentOnboarding,
  requireSdkInitialization,
  sdkInitCommand,
  sdkProjectInstallArgs,
} from './sdk-bootstrap.js';
import { checkSdkUpdate } from './sdk-update.js';
import { copySdkSkills, installProjectSkills } from './skill-install.js';
import type { CommandResult, InitOptions, NewOptions, ProjectCommandOptions } from './types.js';

const execFileAsync = promisify(execFile);

function isMissingPathError(cause: unknown): boolean {
  return cause !== null && typeof cause === 'object' && 'code' in cause && cause.code === 'ENOENT';
}

async function canonicalProspectivePath(path: string): Promise<string> {
  let cursor = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(await realpath(cursor), ...suffix.reverse());
    } catch (cause) {
      if (!isMissingPathError(cause)) throw cause;
      const parent = dirname(cursor);
      if (parent === cursor) throw cause;
      suffix.push(basename(cursor));
      cursor = parent;
    }
  }
}

async function configureSdkStore(root: string, store: string | undefined): Promise<void> {
  if (store === undefined) return;
  const path = resolve(root, '.npmrc');
  let content = '';
  try {
    content = await readFile(path, 'utf8');
  } catch (cause) {
    if (!isMissingPathError(cause)) throw cause;
  }
  const lines = content
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0 && !/^\s*store-dir\s*=/.test(line));
  lines.push(`store-dir=${store}`);
  await writeFile(path, `${lines.join('\n')}\n`);
}

function containsOrEquals(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

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
  return major === 11 && minor >= 7;
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
        expected: 'pnpm >=11.7.0 <12',
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
  try {
    const sdk = await findSdkContext();
    const root = await canonicalProspectivePath(options.root ?? process.cwd());
    if (sdk !== undefined && root === (await canonicalProspectivePath(sdk.root))) {
      return sdkInitCommand(sdk, options);
    }
    const facts = await readProjectFacts(root);
    if (!facts.ok) return facts;
    const plan = createInitPlan(facts.value, sdk?.manifest);
    if (!plan.ok) return plan;
    if (sdk !== undefined && options.dryRun !== true) {
      const initialized = await requireSdkInitialization(sdk);
      if (!initialized.ok) return initialized;
    }
    const applied = await applyInitPlan(facts.value, plan.value, options);
    if (!applied.ok || options.dryRun === true) return applied;
    if (sdk !== undefined) {
      const template = sdk.templates.get(sdk.defaultTemplate);
      if (template === undefined) throw new Error('sdk-default-template-missing');
      await copyFile(
        resolve(template, 'pnpm-lock.yaml'),
        resolve(facts.value.root, 'pnpm-lock.yaml'),
      );
      await copyFile(
        resolve(template, 'pnpm-workspace.yaml'),
        resolve(facts.value.root, 'pnpm-workspace.yaml'),
      );
      try {
        await readFile(resolve(facts.value.root, '.npmrc'), 'utf8');
      } catch (cause) {
        if (!isMissingPathError(cause)) throw cause;
        try {
          await copyFile(resolve(template, '.npmrc'), resolve(facts.value.root, '.npmrc'));
        } catch (templateCause) {
          if (!isMissingPathError(templateCause)) throw templateCause;
        }
      }
      await copySdkSkills(sdk, facts.value.root);
      await installProjectSkills(facts.value.root, sdk.manifest);
      await configureSdkStore(
        facts.value.root,
        sdk.store === undefined ? undefined : await canonicalProspectivePath(sdk.store),
      );
    }
    if (options.install === false) return applied;
    const store =
      sdk === undefined || sdk.store === undefined
        ? undefined
        : await canonicalProspectivePath(sdk.store);
    const installArgs =
      sdk === undefined ? ['install', '--frozen-lockfile=false'] : sdkProjectInstallArgs(store);
    await execFileAsync('pnpm', installArgs, {
      cwd: facts.value.root,
      env: { ...process.env, CI: 'true' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return applied;
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-init-failed') };
  }
}

export async function newCommand(options: NewOptions = {}): Promise<CommandResult<unknown>> {
  try {
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
    if (
      containsOrEquals(
        await canonicalProspectivePath(sdk.root),
        await canonicalProspectivePath(root),
      )
    ) {
      return {
        ok: false,
        error: {
          code: 'project-target-inside-sdk',
          expected: 'forgeax new target to be outside the unpacked SDK root',
          hint: 'Choose a sibling directory or an absolute path outside the SDK.',
          detail: { root, sdkRoot: sdk.root },
        },
      };
    }
    const templateId = options.template ?? sdk.defaultTemplate;
    const template = sdk.templates.get(templateId);
    if (template === undefined) {
      return {
        ok: false,
        error: {
          code: 'sdk-template-not-found',
          expected: 'a template id declared by sdk-manifest.json',
          hint: `Choose one of: ${[...sdk.templates.keys()].sort().join(', ')}.`,
          detail: { template: templateId },
        },
      };
    }
    let targetExists = true;
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (cause) {
      if (!isMissingPathError(cause)) throw cause;
      targetExists = false;
      entries = [];
    }
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
        value: { root, template: templateId, sdkVersion: sdk.manifest.sdkVersion },
      };
    }
    const initialized = await requireSdkInitialization(sdk);
    if (!initialized.ok) return initialized;
    const parent = dirname(root);
    await mkdir(parent, { recursive: true });
    let staging: string | undefined = await mkdtemp(
      resolve(parent, `.${basename(root)}.forgeax-staging-`),
    );
    const committedNames: string[] = [];
    let committed = false;
    try {
      for (const name of await readdir(template)) {
        await cp(resolve(template, name), resolve(staging, name), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
      }
      await copySdkSkills(sdk, staging);
      await installProjectSkills(staging, sdk.manifest);
      const store = sdk.store === undefined ? undefined : await canonicalProspectivePath(sdk.store);
      await configureSdkStore(staging, store);
      if (!targetExists) {
        await rename(staging, root);
        staging = undefined;
        committedNames.push(...(await readdir(root)));
      } else {
        for (const name of await readdir(staging)) {
          await rename(resolve(staging, name), resolve(root, name));
          committedNames.push(name);
        }
        await rm(staging, { recursive: true, force: true });
        staging = undefined;
      }
      committed = true;
      // Install after the final rename so pnpm's virtual-store metadata keeps
      // the real project path. Installing inside staging would force a second
      // registry resolution when `pnpm exec` runs from the committed project.
      await execFileAsync('pnpm', sdkProjectInstallArgs(store), {
        cwd: root,
        env: { ...process.env, CI: 'true' },
        maxBuffer: 16 * 1024 * 1024,
      });
      const sdkUpdate = await checkSdkUpdate(sdk.manifest.sdkVersion);
      return {
        ok: true,
        value: {
          root,
          template: templateId,
          sdkVersion: sdk.manifest.sdkVersion,
          onboarding: agentOnboarding(sdk, root),
          sdkUpdate,
        },
      };
    } catch (cause) {
      if (staging !== undefined) await rm(staging, { recursive: true, force: true });
      if (committed) {
        if (!targetExists) {
          await rm(root, { recursive: true, force: true });
          return { ok: false, error: commandError(cause, 'project-create-failed') };
        }
        const cleanupNames = new Set([...committedNames, 'node_modules']);
        await Promise.all(
          [...cleanupNames].map((name) =>
            rm(resolve(root, name), { recursive: true, force: true }),
          ),
        );
      } else {
        await Promise.all(
          committedNames.map((name) => rm(resolve(root, name), { recursive: true, force: true })),
        );
      }
      return { ok: false, error: commandError(cause, 'project-create-failed') };
    }
  } catch (cause) {
    return { ok: false, error: commandError(cause, 'project-create-failed') };
  }
}

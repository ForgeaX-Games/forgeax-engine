import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { SdkContext } from './sdk.js';
import type { CommandResult } from './types.js';

const execFileAsync = promisify(execFile);
const SDK_INIT_PATH = ['.forgeax', 'sdk-init.json'] as const;
const SDK_INIT_SCHEMA_VERSION = '1.0.0' as const;

export interface SdkInitState {
  readonly schemaVersion: typeof SDK_INIT_SCHEMA_VERSION;
  readonly sdkVersion: string;
  readonly engineCommit: string;
  readonly pnpm: string;
  readonly node: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

export interface SdkInitReport extends SdkInitState {
  readonly root: string;
  readonly store: 'offline' | 'registry';
  readonly onboarding: AgentOnboarding;
}

export interface AgentOnboarding {
  readonly read: readonly string[];
  readonly next: {
    readonly cwd: string;
    readonly argv: readonly string[];
  };
}

export function agentOnboarding(sdk: SdkContext, projectRoot?: string): AgentOnboarding {
  const root = projectRoot ?? sdk.root;
  return {
    read: [
      resolve(root, 'AGENTS.md'),
      resolve(root, 'skills', 'forgeax-engine-sdk', 'SKILL.md'),
      resolve(root, 'skills', 'forgeax-engine-sdk', 'references', 'feature-catalog.md'),
    ],
    next:
      projectRoot === undefined
        ? {
            cwd: root,
            argv: ['node', './bin/forgeax.mjs', 'new', '../my-game'],
          }
        : { cwd: root, argv: ['pnpm', 'exec', 'forgeax', 'list', '--json'] },
  };
}

function sdkInitPath(sdk: SdkContext): string {
  return resolve(sdk.root, ...SDK_INIT_PATH);
}

function commandFailure(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
): CommandResult<never> {
  return { ok: false, error: { code, expected, hint, detail } };
}

export function sdkProjectInstallArgs(store: string | undefined): string[] {
  const common = [
    'install',
    '--frozen-lockfile',
    '--ignore-scripts',
    '--config.pm-on-fail=ignore',
    '--side-effects-cache=true',
    '--child-concurrency=1',
  ];
  return store === undefined
    ? common
    : [...common, '--offline', '--config.trust-lockfile=true', '--store-dir', store];
}

function sdkBootstrapInstallArgs(store: string | undefined): string[] {
  const common = [
    'install',
    '--frozen-lockfile',
    '--config.pm-on-fail=ignore',
    '--child-concurrency=1',
    '--side-effects-cache=true',
  ];
  return store === undefined
    ? common
    : [...common, '--offline', '--config.trust-lockfile=true', '--store-dir', store];
}

function supportedPnpm(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  return major === 11 && minor >= 7;
}

async function currentPnpm(): Promise<CommandResult<string>> {
  try {
    const result = await execFileAsync('pnpm', ['--version'], { maxBuffer: 1024 * 1024 });
    const version = result.stdout.trim();
    if (version.length === 0) throw new Error('pnpm returned an empty version');
    return { ok: true, value: version };
  } catch (cause) {
    return commandFailure(
      'pnpm-unavailable',
      'pnpm 11.7.0 or newer in the pnpm 11 line to be available on PATH',
      'Install or activate pnpm 11, then rerun forgeax init from the SDK root.',
      { reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

function matchesState(sdk: SdkContext, state: unknown): state is SdkInitState {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return false;
  const value = state as Record<string, unknown>;
  return (
    value.schemaVersion === SDK_INIT_SCHEMA_VERSION &&
    value.sdkVersion === sdk.manifest.sdkVersion &&
    value.engineCommit === sdk.manifest.engineCommit &&
    typeof value.pnpm === 'string' &&
    supportedPnpm(value.pnpm) &&
    value.node === process.versions.node &&
    value.platform === process.platform &&
    value.arch === process.arch
  );
}

export async function readSdkInitState(sdk: SdkContext): Promise<SdkInitState | undefined> {
  try {
    const value = JSON.parse(await readFile(sdkInitPath(sdk), 'utf8')) as unknown;
    return matchesState(sdk, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function requireSdkInitialization(
  sdk: SdkContext,
): Promise<CommandResult<SdkInitState>> {
  const state = await readSdkInitState(sdk);
  if (state === undefined) {
    return commandFailure(
      'sdk-not-initialized',
      'the downloaded SDK to be initialized for this Node/pnpm/platform tuple',
      'Run ./bin/forgeax init from the SDK root once, then run forgeax new outside the SDK.',
      {
        sdkRoot: sdk.root,
        sdkVersion: sdk.manifest.sdkVersion,
        pnpm: sdk.manifest.requirements.pnpm,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      },
    );
  }
  return { ok: true, value: state };
}

async function copyBootstrapInputs(sdk: SdkContext, root: string): Promise<void> {
  const template = sdk.templates.get(sdk.defaultTemplate);
  if (template === undefined) throw new Error('sdk-default-template-missing');
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const) {
    await cp(resolve(template, name), resolve(root, name));
  }
  try {
    await cp(resolve(template, '.npmrc'), resolve(root, '.npmrc'));
  } catch (cause) {
    if (
      cause === null ||
      typeof cause !== 'object' ||
      !('code' in cause) ||
      cause.code !== 'ENOENT'
    ) {
      throw cause;
    }
  }
}

export async function sdkInitCommand(
  sdk: SdkContext,
  options: { readonly dryRun?: boolean; readonly install?: boolean } = {},
): Promise<CommandResult<SdkInitReport>> {
  const pnpmResult = await currentPnpm();
  if (!pnpmResult.ok) return pnpmResult;
  if (!supportedPnpm(pnpmResult.value)) {
    return commandFailure(
      'pnpm-version-unsupported',
      'pnpm >=11.7.0 <12',
      'Activate pnpm 11.7.0 or newer in the pnpm 11 line, then rerun forgeax init.',
      { actual: pnpmResult.value, expected: sdk.manifest.requirements.pnpm },
    );
  }
  const state: SdkInitState = {
    schemaVersion: SDK_INIT_SCHEMA_VERSION,
    sdkVersion: sdk.manifest.sdkVersion,
    engineCommit: sdk.manifest.engineCommit,
    pnpm: pnpmResult.value,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  };
  const report: SdkInitReport = {
    ...state,
    root: sdk.root,
    store: sdk.store === undefined ? 'registry' : 'offline',
    onboarding: agentOnboarding(sdk),
  };
  if (options.dryRun === true || options.install === false) return { ok: true, value: report };

  let staging: string | undefined;
  try {
    staging = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-init-'));
    await copyBootstrapInputs(sdk, staging);
    await execFileAsync('pnpm', sdkBootstrapInstallArgs(sdk.store), {
      cwd: staging,
      env: { ...process.env, CI: 'true' },
      maxBuffer: 16 * 1024 * 1024,
    });
    await mkdir(resolve(sdk.root, '.forgeax'), { recursive: true });
    await writeFile(sdkInitPath(sdk), `${JSON.stringify(state, null, 2)}\n`);
    return { ok: true, value: report };
  } catch (cause) {
    return commandFailure(
      'sdk-init-failed',
      'the SDK dependency closure to install and build native packages successfully',
      'Inspect the pnpm output, repair Node/pnpm or platform permissions, then rerun forgeax init from the SDK root.',
      { reason: cause instanceof Error ? cause.message : String(cause), sdkRoot: sdk.root },
    );
  } finally {
    if (staging !== undefined) await rm(staging, { recursive: true, force: true });
  }
}

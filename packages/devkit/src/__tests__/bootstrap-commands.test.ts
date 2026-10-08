import { createHash } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorCommand, initCommand, newCommand } from '../bootstrap-commands.js';

const originalPath = process.env.PATH;
const originalSdkRoot = process.env.FORGEAX_SDK_ROOT;
const originalInstallState = process.env.FORGEAX_TEST_INSTALL_STATE;
const originalFailFirstInstall = process.env.FORGEAX_TEST_FAIL_FIRST_INSTALL;
const originalNpmConfigOffline = process.env.npm_config_offline;
const temporaryRoots: string[] = [];

interface SdkFixture {
  readonly root: string;
  readonly template: string;
  readonly installState: string;
  readonly bin: string;
}

async function sdkFixture(failFirstInstall = true, withStore = true): Promise<SdkFixture> {
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-new-'));
  temporaryRoots.push(temporaryRoot);
  const root = resolve(temporaryRoot, 'sdk');
  await mkdir(root);
  const template = resolve(root, 'templates', 'empty');
  const fullTemplate = resolve(root, 'templates', 'game-3d');
  const bin = resolve(root, 'bin');
  const installState = resolve(root, 'install-state');
  await mkdir(template, { recursive: true });
  await mkdir(resolve(template, 'src', '__tests__'), { recursive: true });
  await mkdir(fullTemplate, { recursive: true });
  if (withStore) await mkdir(resolve(root, 'store', 'pnpm'), { recursive: true });
  await mkdir(bin, { recursive: true });
  const skillText = '# Test skill\n\nUse the ForgeaX test skill.\n';
  await mkdir(resolve(root, 'skills', 'forgeax-engine-test'), { recursive: true });
  await writeFile(resolve(root, 'skills', 'forgeax-engine-test', 'SKILL.md'), skillText);
  await writeFile(
    resolve(root, 'sdk-manifest.json'),
    `${JSON.stringify({
      schemaVersion: '1.9.0',
      viewCommit: 'view-test',
      sdkVersion: '0.0.0-test',
      engineCommit: 'test',
      requirements: { node: '>=22.13.0', pnpm: '11.7.0', pnpmStoreFormat: 'v11' },
      capabilities: [],
      packages: [],
      templates: [
        { id: 'empty', root: 'templates/empty' },
        { id: 'game-3d', root: 'templates/game-3d' },
      ],
      skills: [
        {
          id: 'forgeax-engine-test',
          root: 'skills/forgeax-engine-test',
          fileCount: 1,
          byteCount: Buffer.byteLength(skillText),
        },
      ],
    })}\n`,
  );
  await mkdir(resolve(root, '.forgeax'), { recursive: true });
  await writeFile(
    resolve(root, '.forgeax', 'sdk-init.json'),
    `${JSON.stringify({
      schemaVersion: '2.0.0',
      sdkVersion: '0.0.0-test',
      engineCommit: 'test',
      pnpm: '11.7.0',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
    })}\n`,
  );
  await writeFile(
    resolve(template, 'forge.json'),
    '{"id":"game","name":"Game","schemaVersion":"3.0.0","roots":{}}\n',
  );
  await writeFile(resolve(template, 'package.json'), '{"name":"game","version":"0.0.0"}\n');
  await writeFile(
    resolve(template, 'template.json'),
    `${JSON.stringify({
      id: 'empty',
      purpose: 'minimal project',
      defaultIdentity: { name: 'empty-game', packageName: '@local/empty-game' },
      journeys: ['typecheck', 'unit'],
    })}\n`,
  );
  await writeFile(resolve(template, 'src', 'main.ts'), 'export async function bootstrap() {}\n');
  await writeFile(
    resolve(template, 'src', '__tests__', 'starter.test.ts'),
    'export const starter = true;\n',
  );
  await writeFile(resolve(template, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(
    resolve(template, 'pnpm-workspace.yaml'),
    "allowBuilds:\n  esbuild: true\nminimumReleaseAgeExclude:\n  - '@forgeax/*'\ntrustLockfile: true\nverifyDepsBeforeRun: warn\nenableGlobalVirtualStore: false\n",
  );
  await writeFile(resolve(template, '.npmrc'), 'public-hoist-pattern[]=@forgeax/engine-*\n');
  await writeFile(
    resolve(fullTemplate, 'forge.json'),
    '{"id":"full-game","name":"Full Game","schemaVersion":"3.0.0","roots":{}}\n',
  );
  await writeFile(resolve(fullTemplate, 'package.json'), '{"name":"full","version":"0.0.0"}\n');
  await writeFile(
    resolve(fullTemplate, 'template.json'),
    `${JSON.stringify({
      id: 'game-3d',
      purpose: 'three-dimensional game project',
      defaultIdentity: { name: 'game-3d', packageName: '@local/game-3d' },
      journeys: ['typecheck', 'unit', 'browser'],
    })}\n`,
  );
  await writeFile(resolve(fullTemplate, 'main.ts'), 'export default {}\n');
  await writeFile(resolve(fullTemplate, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(
    resolve(fullTemplate, 'pnpm-workspace.yaml'),
    "allowBuilds:\n  esbuild: true\nminimumReleaseAgeExclude:\n  - '@forgeax/*'\ntrustLockfile: true\nverifyDepsBeforeRun: warn\nenableGlobalVirtualStore: false\n",
  );
  const pnpm = resolve(bin, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
  const pnpmScript = resolve(bin, 'pnpm-fixture.mjs');
  await writeFile(
    pnpmScript,
    `${[
      "import { access, mkdir, realpath, writeFile } from 'node:fs/promises';",
      "import { resolve } from 'node:path';",
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') { process.stdout.write('11.7.0\\n'); process.exit(0); }",
      'const state = process.env.FORGEAX_TEST_INSTALL_STATE;',
      "if (!state) throw new Error('missing FORGEAX_TEST_INSTALL_STATE');",
      "await writeFile(state + '.args', args.join('\\n') + '\\n');",
      "await writeFile(state + '.cwd', (await realpath(process.cwd())) + '\\n');",
      "await writeFile(state + '.ci', (process.env.CI ?? '') + '\\n');",
      'let alreadyInstalled = true;',
      'try { await access(state); } catch { alreadyInstalled = false; }',
      'if (!alreadyInstalled) {',
      "  await writeFile(state, '');",
      "  if (process.env.FORGEAX_TEST_FAIL_FIRST_INSTALL === '1') {",
      "    process.stderr.write('deterministic offline install fault\\n');",
      '    process.exit(23);',
      '  }',
      '}',
      "await mkdir(resolve(process.cwd(), 'node_modules'), { recursive: true });",
    ].join('\n')}\n`,
  );
  if (process.platform === 'win32') {
    await writeFile(pnpm, `@echo off\r\n"${process.execPath}" "${pnpmScript}" %*\r\n`);
  } else {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(pnpm, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(pnpmScript)} "$@"\n`);
    await chmod(pnpm, 0o755);
  }
  const toolchain = resolve(root, 'toolchain/cli-runtime');
  const runtime = resolve(root, '.forgeax/cli-runtime');
  await mkdir(toolchain, { recursive: true });
  await mkdir(runtime, { recursive: true });
  const hash = createHash('sha256');
  for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    await cp(resolve(template, name), resolve(toolchain, name));
    await cp(resolve(template, name), resolve(runtime, name));
    hash.update(await readFile(resolve(toolchain, name)));
  }
  await mkdir(resolve(runtime, 'node_modules/@forgeax/engine/dist/bin'), { recursive: true });
  await writeFile(
    resolve(runtime, 'node_modules/@forgeax/engine/dist/bin/forgeax.mjs'),
    'export {};',
  );
  const view = resolve(runtime, 'node_modules/@forgeax/view');
  await mkdir(view, { recursive: true });
  await writeFile(
    resolve(view, 'package.json'),
    JSON.stringify({ name: '@forgeax/view', exports: { './host.pack.json': './host.pack.json' } }),
  );
  await writeFile(resolve(view, 'host.pack.json'), '{}');
  const state = JSON.parse(await readFile(resolve(root, '.forgeax/sdk-init.json'), 'utf8'));
  state.toolInputsDigest = hash.digest('hex');
  await writeFile(resolve(root, '.forgeax/sdk-init.json'), JSON.stringify(state));
  process.env.FORGEAX_SDK_ROOT = root;
  process.env.FORGEAX_TEST_INSTALL_STATE = installState;
  process.env.FORGEAX_TEST_FAIL_FIRST_INSTALL = failFirstInstall ? '1' : '0';
  process.env.PATH = `${bin}${process.platform === 'win32' ? ';' : ':'}${originalPath ?? ''}`;
  process.env.npm_config_offline = 'true';
  return { root, template, installState, bin };
}

async function stagingEntries(parent: string, target: string): Promise<string[]> {
  return (await readdir(parent)).filter((entry) =>
    entry.startsWith(`.${basename(target)}.forgeax-staging-`),
  );
}

afterEach(async () => {
  process.env.PATH = originalPath;
  process.env.FORGEAX_SDK_ROOT = originalSdkRoot;
  process.env.FORGEAX_TEST_INSTALL_STATE = originalInstallState;
  process.env.FORGEAX_TEST_FAIL_FIRST_INSTALL = originalFailFirstInstall;
  process.env.npm_config_offline = originalNpmConfigOffline;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('newCommand', () => {
  it('pins the supported package manager in shipped templates', async () => {
    for (const template of ['empty', 'game-3d']) {
      const packageJson = JSON.parse(
        await readFile(
          resolve(import.meta.dirname, '../../../../templates', template, 'package.json'),
          'utf8',
        ),
      ) as { readonly packageManager?: unknown };
      expect(packageJson.packageManager).toBe('pnpm@11.7.0');
    }
  });

  it('requires one SDK-root init before creating a game', async () => {
    const sdk = await sdkFixture(false);
    await rm(resolve(sdk.root, '.forgeax', 'sdk-init.json'));

    const result = await newCommand({
      root: resolve(sdk.root, '..', 'uninitialized-game'),
      template: 'empty',
    });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sdk-not-initialized' }),
    });
    await expect(readdir(resolve(sdk.root, '..', 'uninitialized-game'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('rejects a partial tool runtime even when installation exits successfully', async () => {
    const sdk = await sdkFixture(false);
    await rm(resolve(sdk.root, '.forgeax/sdk-init.json'));
    await rm(resolve(sdk.root, '.forgeax/cli-runtime/node_modules/@forgeax/view'), {
      recursive: true,
    });
    const result = await initCommand({ root: sdk.root });
    expect(result).toMatchObject({ ok: false, error: { code: 'sdk-init-failed' } });
    await expect(readFile(resolve(sdk.root, '.forgeax/sdk-init.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('initializes the SDK closure once at the SDK root', async () => {
    const sdk = await sdkFixture(false);
    await rm(resolve(sdk.root, '.forgeax', 'sdk-init.json'));

    const result = await initCommand({ root: sdk.root });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        root: sdk.root,
        sdkVersion: '0.0.0-test',
        store: 'offline',
        onboarding: {
          read: [
            resolve(sdk.root, 'AGENTS.md'),
            resolve(sdk.root, 'skills/forgeax-engine-sdk/SKILL.md'),
            resolve(sdk.root, 'skills/forgeax-engine-sdk/references/feature-catalog.md'),
          ],
          templateSelection: {
            required: true,
            available: ['empty', 'game-3d'],
          },
        },
      }),
    });
    expect(
      JSON.parse(await readFile(resolve(sdk.root, '.forgeax', 'sdk-init.json'), 'utf8')),
    ).toEqual(
      expect.objectContaining({
        schemaVersion: '2.0.0',
        sdkVersion: '0.0.0-test',
        engineCommit: 'test',
        pnpm: '11.7.0',
      }),
    );
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).toContain(
      '--side-effects-cache=true\n',
    );
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).toContain(
      '--config.pm-on-fail=ignore\n',
    );
  });

  it.each(['root', 'nested'] as const)('refuses an SDK-owned %s target', async (scope) => {
    const sdk = await sdkFixture(false);
    const targetRoot = scope === 'root' ? sdk.root : resolve(sdk.root, 'games', 'game');

    const result = await newCommand({ root: targetRoot, template: 'empty' });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'project-target-inside-sdk',
        expected: 'forgeax project new target to be outside the unpacked SDK root',
        hint: 'Choose a sibling directory or an absolute path outside the SDK.',
        detail: { root: targetRoot, sdkRoot: sdk.root },
      },
    });
    if (scope === 'nested') {
      await expect(readdir(targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    }
    await expect(readFile(sdk.installState, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    { label: 'absent', target: 'absent-game' },
    { label: 'empty', target: 'empty-game' },
  ])('rolls back a failed install for an $label target and retries in-process', async ({
    target,
  }) => {
    const sdk = await sdkFixture();
    const targetRoot = resolve(sdk.root, '..', target);
    if (target === 'empty-game') await mkdir(targetRoot);
    const originalEntries = target === 'empty-game' ? await readdir(targetRoot) : undefined;

    const failed = await newCommand({ root: targetRoot, template: 'empty' });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe('project-create-failed');
      expect(JSON.stringify(failed.error.detail)).toContain('deterministic offline install fault');
    }
    if (originalEntries === undefined) {
      await expect(readdir(targetRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } else {
      expect(await readdir(targetRoot)).toEqual(originalEntries);
    }
    expect(await stagingEntries(dirname(targetRoot), targetRoot)).toEqual([]);

    const retried = await newCommand({ root: targetRoot, template: 'empty' });
    expect(retried.ok).toBe(true);
    expect(await readFile(resolve(targetRoot, 'pnpm-lock.yaml'), 'utf8')).toBe(
      'lockfileVersion: 9.0\n',
    );
    expect(await readFile(resolve(targetRoot, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      "allowBuilds:\n  esbuild: true\nminimumReleaseAgeExclude:\n  - '@forgeax/*'\ntrustLockfile: true\nverifyDepsBeforeRun: warn\nenableGlobalVirtualStore: false\n",
    );
    expect(JSON.parse(await readFile(resolve(targetRoot, 'forge.json'), 'utf8'))).toEqual({
      id: target,
      name: target,
      schemaVersion: '3.0.0',
      roots: {},
    });
    expect(JSON.parse(await readFile(resolve(targetRoot, 'package.json'), 'utf8')).name).toBe(
      `@local/${target}`,
    );
    expect(await readFile(resolve(targetRoot, 'src', '__tests__', 'starter.test.ts'), 'utf8')).toBe(
      'export const starter = true;\n',
    );
    expect(await readdir(resolve(targetRoot, 'node_modules'))).toEqual([]);
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).toContain(
      '--side-effects-cache=true\n',
    );
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).toContain(
      '--config.pm-on-fail=ignore\n',
    );
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).toContain(
      '--config.trust-lockfile=true\n',
    );
    expect(await readFile(`${sdk.installState}.ci`, 'utf8')).toBe('true\n');
    expect(await readFile(`${sdk.installState}.cwd`, 'utf8')).toBe(
      `${await realpath(targetRoot)}\n`,
    );
    expect(await readFile(resolve(targetRoot, '.npmrc'), 'utf8')).toBe(
      `public-hoist-pattern[]=@forgeax/engine-*\nstore-dir=${await realpath(resolve(sdk.root, 'store', 'pnpm'))}\n`,
    );
    expect(await readFile(resolve(targetRoot, 'skills/forgeax-engine-test/SKILL.md'), 'utf8')).toBe(
      '# Test skill\n\nUse the ForgeaX test skill.\n',
    );
    const mounted = resolve(targetRoot, '.agents/skills/forgeax-engine-test');
    expect((await lstat(mounted)).isSymbolicLink()).toBe(true);
    expect(resolve(targetRoot, '.agents/skills', await readlink(mounted))).toBe(
      resolve(targetRoot, 'skills/forgeax-engine-test'),
    );
    expect(
      JSON.parse(
        await readFile(resolve(targetRoot, '.forgeax/skill-install-manifest.json'), 'utf8'),
      ).skills,
    ).toEqual([
      expect.objectContaining({ id: 'forgeax-engine-test', root: 'skills/forgeax-engine-test' }),
    ]);
    expect(await stagingEntries(dirname(targetRoot), targetRoot)).toEqual([]);
  });

  it('contains malformed SDK manifest JSON and retries new and init in-process', async () => {
    const sdk = await sdkFixture(false);
    const manifestPath = resolve(sdk.root, 'sdk-manifest.json');
    const validManifest = await readFile(manifestPath, 'utf8');
    const newRoot = resolve(sdk.root, '..', 'malformed-new-game');
    const initRoot = resolve(sdk.root, '..', 'malformed-init-game');
    await mkdir(initRoot);
    const initFiles = {
      forge: resolve(initRoot, 'forge.json'),
      package: resolve(initRoot, 'package.json'),
      entry: resolve(initRoot, 'main.ts'),
    };
    await writeFile(
      initFiles.forge,
      `${JSON.stringify({
        id: 'game',
        name: 'Game',
        schemaVersion: '3.0.0',
        roots: {},
      })}\n`,
    );
    await writeFile(initFiles.package, '{"name":"game","version":"0.0.0"}\n');
    await writeFile(initFiles.entry, 'export default {}\n');
    const beforeInit = await Promise.all(
      Object.values(initFiles).map(async (path) => [path, await readFile(path, 'utf8')] as const),
    );
    await writeFile(manifestPath, '{"schemaVersion":\n');

    const failedNew = await newCommand({ root: newRoot, template: 'empty' });
    expect(failedNew.ok).toBe(false);
    if (!failedNew.ok) {
      expect(failedNew.error.code).toBe('project-create-failed');
      expect(failedNew.error.detail.reason).toMatch(/JSON|Expected/);
    }
    await expect(readdir(newRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await stagingEntries(dirname(newRoot), newRoot)).toEqual([]);

    const failedInit = await initCommand({ root: initRoot });
    expect(failedInit.ok).toBe(false);
    if (!failedInit.ok) {
      expect(failedInit.error.code).toBe('project-init-failed');
      expect(failedInit.error.detail.reason).toMatch(/JSON|Expected/);
    }
    await expect(readFile(sdk.installState, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(
      await Promise.all(
        Object.values(initFiles).map(async (path) => [path, await readFile(path, 'utf8')] as const),
      ),
    ).toEqual(beforeInit);

    await writeFile(manifestPath, validManifest);
    const retriedNew = await newCommand({ root: newRoot, template: 'empty' });
    expect(retriedNew.ok).toBe(true);
    const retriedInit = await initCommand({ root: initRoot });
    expect(retriedInit.ok).toBe(true);
    expect(await readFile(sdk.installState, 'utf8')).toBe('');
    expect(await readFile(`${sdk.installState}.ci`, 'utf8')).toBe('true\n');
    expect(JSON.parse(await readFile(initFiles.package, 'utf8')).packageManager).toBe(
      'pnpm@11.7.0',
    );
    expect(await readFile(resolve(initRoot, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      "allowBuilds:\n  esbuild: true\nminimumReleaseAgeExclude:\n  - '@forgeax/*'\ntrustLockfile: true\nverifyDepsBeforeRun: warn\nenableGlobalVirtualStore: false\n",
    );
    expect(await stagingEntries(dirname(newRoot), newRoot)).toEqual([]);
  });

  it('preserves genuinely pre-existing content and refuses a non-empty target', async () => {
    const sdk = await sdkFixture();
    const targetRoot = resolve(sdk.root, '..', 'existing-game');
    await mkdir(targetRoot);
    const sentinel = resolve(targetRoot, 'keep.txt');
    await writeFile(sentinel, 'do not overwrite\n');

    const result = await newCommand({ root: targetRoot, template: 'empty' });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'project-target-not-empty' }),
    });
    expect(await readFile(sentinel, 'utf8')).toBe('do not overwrite\n');
    await expect(readFile(resolve(sdk.installState), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('requires an explicit template and selects each named SDK template', async () => {
    const sdk = await sdkFixture(false);
    const defaultRoot = resolve(sdk.root, '..', 'default-game');
    const fullRoot = resolve(sdk.root, '..', 'full-game');

    const requiredResult = await newCommand({ root: resolve(sdk.root, '..', 'required-game') });
    const defaultResult = await newCommand({ root: defaultRoot, template: 'empty' });
    const fullResult = await newCommand({ root: fullRoot, template: 'game-3d' });
    const missingResult = await newCommand({
      root: resolve(sdk.root, '..', 'missing-game'),
      template: 'missing',
    });

    expect(requiredResult).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sdk-template-required' }),
    });
    expect(defaultResult).toEqual({
      ok: true,
      value: expect.objectContaining({
        template: 'empty',
        onboarding: {
          read: [
            resolve(defaultRoot, 'AGENTS.md'),
            resolve(defaultRoot, 'skills/forgeax-engine-sdk/SKILL.md'),
            resolve(defaultRoot, 'skills/forgeax-engine-sdk/references/feature-catalog.md'),
          ],
          next: {
            cwd: defaultRoot,
            argv: ['pnpm', 'exec', 'forgeax', 'help', '--tree', '--json'],
          },
        },
        sdkUpdate: { status: 'skipped', currentVersion: '0.0.0-test', reason: 'offline' },
      }),
    });
    expect(JSON.parse(await readFile(resolve(defaultRoot, 'forge.json'), 'utf8'))).toEqual(
      expect.objectContaining({ id: 'default-game', name: 'default-game' }),
    );
    expect(JSON.parse(await readFile(resolve(defaultRoot, 'package.json'), 'utf8')).name).toBe(
      '@local/default-game',
    );
    expect(fullResult).toEqual({
      ok: true,
      value: expect.objectContaining({ template: 'game-3d' }),
    });
    expect(JSON.parse(await readFile(resolve(fullRoot, 'forge.json'), 'utf8'))).toEqual(
      expect.objectContaining({ id: 'full-game', name: 'full-game' }),
    );
    expect(JSON.parse(await readFile(resolve(fullRoot, 'package.json'), 'utf8')).name).toBe(
      '@local/full-game',
    );
    expect(missingResult).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sdk-template-not-found' }),
    });
  });

  it('uses the registry when the npm carrier omits its offline store', async () => {
    const sdk = await sdkFixture(false, false);
    const targetRoot = resolve(sdk.root, '..', 'online-game');

    const result = await newCommand({ root: targetRoot, template: 'empty' });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ template: 'empty' }),
    });
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).toContain(
      'install\n--frozen-lockfile\n--ignore-scripts\n',
    );
  });

  it('accepts explicit identity fields and rejects an unsafe target basename before side effects', async () => {
    const sdk = await sdkFixture(false);
    const targetRoot = resolve(sdk.root, '..', 'explicit-game');
    const explicit = await newCommand({
      root: targetRoot,
      template: 'empty',
      id: 'stable-game',
      name: 'Stable Game',
      packageName: '@studio/stable-game',
    });

    expect(explicit.ok).toBe(true);
    expect(JSON.parse(await readFile(resolve(targetRoot, 'forge.json'), 'utf8'))).toEqual(
      expect.objectContaining({ id: 'stable-game', name: 'Stable Game' }),
    );
    expect(JSON.parse(await readFile(resolve(targetRoot, 'package.json'), 'utf8')).name).toBe(
      '@studio/stable-game',
    );

    const unsafeRoot = resolve(sdk.root, '..', 'Unsafe Game');
    const unsafe = await newCommand({ root: unsafeRoot, template: 'empty' });
    expect(unsafe).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'project-identity-invalid' }),
    });
    await expect(readdir(unsafeRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('doctorCommand', () => {
  it('resolves the project package manager through Corepack before plain pnpm', async () => {
    const sdk = await sdkFixture(false);
    await writeFile(
      resolve(sdk.template, 'package.json'),
      '{"name":"game","version":"0.0.0","packageManager":"pnpm@11.7.0"}\n',
    );
    const argsPath = `${sdk.installState}.corepack-args`;
    const corepack = resolve(sdk.bin, process.platform === 'win32' ? 'corepack.cmd' : 'corepack');
    const corepackScript = resolve(sdk.bin, 'corepack-fixture.mjs');
    await writeFile(
      corepackScript,
      `import { writeFile } from 'node:fs/promises';\nawait writeFile(${JSON.stringify(argsPath)}, process.argv.slice(2).join('\\n') + '\\n');\nprocess.stdout.write('11.7.0\\n');\n`,
    );
    if (process.platform === 'win32') {
      await writeFile(corepack, `@echo off\r\n"${process.execPath}" "${corepackScript}" %*\r\n`);
    } else {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      await writeFile(
        corepack,
        `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(corepackScript)} "$@"\n`,
      );
      await chmod(corepack, 0o755);
    }

    const result = await doctorCommand({ root: sdk.template });

    expect(result).toMatchObject({ ok: true, value: { pnpm: '11.7.0' } });
    expect(await readFile(argsPath, 'utf8')).toBe('pnpm\n--version\n');
  });
});

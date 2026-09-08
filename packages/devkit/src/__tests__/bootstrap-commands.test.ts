import {
  chmod,
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
import { initCommand, newCommand } from '../bootstrap-commands.js';

const originalPath = process.env.PATH;
const originalSdkRoot = process.env.FORGEAX_SDK_ROOT;
const originalInstallState = process.env.FORGEAX_TEST_INSTALL_STATE;
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
  const template = resolve(root, 'templates', 'game-empty');
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
      schemaVersion: '1.6.0',
      sdkVersion: '0.0.0-test',
      engineCommit: 'test',
      requirements: { node: '>=22.13.0', pnpm: '11.7.0', pnpmStoreFormat: 'v11' },
      capabilities: [],
      packages: [],
      templates: [
        { id: 'empty', root: 'templates/game-empty', default: true },
        { id: 'game-3d', root: 'templates/game-3d', default: false },
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
      schemaVersion: '1.0.0',
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
    '{"id":"game","name":"Game","entry":"src/main.ts"}\n',
  );
  await writeFile(resolve(template, 'package.json'), '{"name":"game","version":"0.0.0"}\n');
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
    '{"id":"full-game","name":"Full Game","entry":"main.ts"}\n',
  );
  await writeFile(resolve(fullTemplate, 'package.json'), '{"name":"full","version":"0.0.0"}\n');
  await writeFile(resolve(fullTemplate, 'main.ts'), 'export default {}\n');
  await writeFile(resolve(fullTemplate, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await writeFile(
    resolve(fullTemplate, 'pnpm-workspace.yaml'),
    "allowBuilds:\n  esbuild: true\nminimumReleaseAgeExclude:\n  - '@forgeax/*'\ntrustLockfile: true\nverifyDepsBeforeRun: warn\nenableGlobalVirtualStore: false\n",
  );
  const pnpm = resolve(bin, 'pnpm');
  await writeFile(
    pnpm,
    '#!/bin/sh\n' +
      'if [ "$1" = "--version" ]; then printf "11.7.0\\n"; exit 0; fi\n' +
      'printf "%s\\n" "$@" > "$FORGEAX_TEST_INSTALL_STATE.args"\n' +
      'printf "%s\\n" "$PWD" > "$FORGEAX_TEST_INSTALL_STATE.cwd"\n' +
      'printf "%s\\n" "$CI" > "$FORGEAX_TEST_INSTALL_STATE.ci"\n' +
      'if [ ! -e "$FORGEAX_TEST_INSTALL_STATE" ]; then\n' +
      '  : > "$FORGEAX_TEST_INSTALL_STATE"\n' +
      (failFirstInstall
        ? '  echo "deterministic offline install fault" >&2\n' + '  exit 23\n'
        : '') +
      'fi\n' +
      'mkdir -p "$PWD/node_modules"\n',
  );
  await chmod(pnpm, 0o755);
  process.env.FORGEAX_SDK_ROOT = root;
  process.env.FORGEAX_TEST_INSTALL_STATE = installState;
  process.env.PATH = `${bin}:${originalPath ?? ''}`;
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
  process.env.npm_config_offline = originalNpmConfigOffline;
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('newCommand', () => {
  it('requires one SDK-root init before creating a game', async () => {
    const sdk = await sdkFixture(false);
    await rm(resolve(sdk.root, '.forgeax', 'sdk-init.json'));

    const result = await newCommand({ root: resolve(sdk.root, '..', 'uninitialized-game') });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sdk-not-initialized' }),
    });
    await expect(readdir(resolve(sdk.root, '..', 'uninitialized-game'))).rejects.toMatchObject({
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
          next: {
            cwd: sdk.root,
            argv: ['node', './bin/forgeax.mjs', 'new', '../my-game'],
          },
        },
      }),
    });
    expect(
      JSON.parse(await readFile(resolve(sdk.root, '.forgeax', 'sdk-init.json'), 'utf8')),
    ).toEqual(
      expect.objectContaining({
        schemaVersion: '1.0.0',
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

    const result = await newCommand({ root: targetRoot });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'project-target-inside-sdk',
        expected: 'forgeax new target to be outside the unpacked SDK root',
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

    const failed = await newCommand({ root: targetRoot });
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

    const retried = await newCommand({ root: targetRoot });
    expect(retried.ok).toBe(true);
    expect(await readFile(resolve(targetRoot, 'pnpm-lock.yaml'), 'utf8')).toBe(
      'lockfileVersion: 9.0\n',
    );
    expect(await readFile(resolve(targetRoot, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      "allowBuilds:\n  esbuild: true\nminimumReleaseAgeExclude:\n  - '@forgeax/*'\ntrustLockfile: true\nverifyDepsBeforeRun: warn\nenableGlobalVirtualStore: false\n",
    );
    expect(await readFile(resolve(targetRoot, 'forge.json'), 'utf8')).toBe(
      '{"id":"game","name":"Game","entry":"src/main.ts"}\n',
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
        schemaVersion: '1.0.0',
        entry: 'main.ts',
        plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
      })}\n`,
    );
    await writeFile(initFiles.package, '{"name":"game","version":"0.0.0"}\n');
    await writeFile(initFiles.entry, 'export default {}\n');
    const beforeInit = await Promise.all(
      Object.values(initFiles).map(async (path) => [path, await readFile(path, 'utf8')] as const),
    );
    await writeFile(manifestPath, '{"schemaVersion":\n');

    const failedNew = await newCommand({ root: newRoot });
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
    const retriedNew = await newCommand({ root: newRoot });
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

    const result = await newCommand({ root: targetRoot });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'project-target-not-empty' }),
    });
    expect(await readFile(sentinel, 'utf8')).toBe('do not overwrite\n');
    await expect(readFile(resolve(sdk.installState), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('uses empty by default and selects a named SDK template', async () => {
    const sdk = await sdkFixture(false);
    const defaultRoot = resolve(sdk.root, '..', 'default-game');
    const fullRoot = resolve(sdk.root, '..', 'full-game');

    const defaultResult = await newCommand({ root: defaultRoot });
    const fullResult = await newCommand({ root: fullRoot, template: 'game-3d' });
    const missingResult = await newCommand({
      root: resolve(sdk.root, '..', 'missing-game'),
      template: 'missing',
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
          next: { cwd: defaultRoot, argv: ['pnpm', 'exec', 'forgeax', 'list', '--json'] },
        },
        sdkUpdate: { status: 'skipped', currentVersion: '0.0.0-test', reason: 'offline' },
      }),
    });
    expect(JSON.parse(await readFile(resolve(defaultRoot, 'forge.json'), 'utf8')).id).toBe('game');
    expect(fullResult).toEqual({
      ok: true,
      value: expect.objectContaining({ template: 'game-3d' }),
    });
    expect(JSON.parse(await readFile(resolve(fullRoot, 'forge.json'), 'utf8')).id).toBe(
      'full-game',
    );
    expect(missingResult).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sdk-template-not-found' }),
    });
  });

  it('uses the registry when the npm carrier omits its offline store', async () => {
    const sdk = await sdkFixture(false, false);
    const targetRoot = resolve(sdk.root, '..', 'online-game');

    const result = await newCommand({ root: targetRoot });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({ template: 'empty' }),
    });
    expect(await readFile(`${sdk.installState}.args`, 'utf8')).toContain(
      'install\n--frozen-lockfile\n--ignore-scripts\n',
    );
  });
});

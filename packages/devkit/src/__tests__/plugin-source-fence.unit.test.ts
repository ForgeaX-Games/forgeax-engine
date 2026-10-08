import { mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const observation = vi.hoisted(() => ({
  reads: new Map<string, number>(),
  afterRealpath: undefined as ((path: string) => Promise<void>) | undefined,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      const path = String(args[0]);
      observation.reads.set(path, (observation.reads.get(path) ?? 0) + 1);
      return actual.readFile(...args);
    },
    realpath: async (...args: Parameters<typeof actual.realpath>) => {
      const path = await actual.realpath(...args);
      await observation.afterRealpath?.(String(path));
      return path;
    },
  };
});

import {
  assertPluginSourceInputs,
  capturePluginProgramInputs,
  discoverPluginAssets,
} from '../build/plugin-assets.js';

const temporary: string[] = [];
afterEach(async () => {
  observation.afterRealpath = undefined;
  observation.reads.clear();
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), 'forgeax-source-fence-')));
  temporary.push(root);
  const files = {
    'assets/helper.ts': 'export const value = 1;',
    'surface.wgsl': '#define_import_path fixture::surface\nconst value = 1.0;',
    'package.json': '{"name":"fixture","type":"module","dependencies":{"external":"1"}}',
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'bun.lock': '{"lockfileVersion":1}',
    'vendor/forgeax-engine/apps/parity/case/manifest.json': '{"case":"retained"}',
    'vendor/forgeax-voxel/packages/voxel/src/runtime.ts': 'export const revision = 1;',
    'dist/plugin.mjs': 'import { value } from "./shared.mjs"; export default { value };',
    'dist/shared.mjs': 'export const value = 1;',
    '.forgeax/catalog.json': '{"disposable":1}',
  };
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
  await capturePluginProgramInputs(
    root,
    inventory.sourceInputs,
    resolve(root, 'dist/plugin.mjs'),
    async (specifier, importer) =>
      isAbsolute(specifier)
        ? specifier
        : specifier.startsWith('.')
          ? resolve(dirname(importer), specifier)
          : undefined,
  );
  observation.reads.clear();
  return { root, inventory };
}

describe('plugin source publication fence', () => {
  it('reads every retained input exactly once, including vendor authority and explicit dist closure', async () => {
    const { root, inventory } = await fixture();
    await expect(assertPluginSourceInputs(inventory, root)).resolves.toBeUndefined();
    const expected = [...inventory.sourceInputs.keys()].sort();
    expect([...observation.reads.keys()].sort()).toEqual(expected);
    expect([...observation.reads.values()]).toEqual(expected.map(() => 1));
    expect(expected.map((path) => relative(root, path))).toEqual(
      expect.arrayContaining([
        'surface.wgsl',
        'package.json',
        'pnpm-lock.yaml',
        'bun.lock',
        'vendor/forgeax-engine/apps/parity/case/manifest.json',
        'vendor/forgeax-voxel/packages/voxel/src/runtime.ts',
        'dist/plugin.mjs',
        'dist/shared.mjs',
      ]),
    );
  });

  it.each([
    'assets/helper.ts',
    'surface.wgsl',
    'package.json',
    'pnpm-lock.yaml',
    'bun.lock',
    'vendor/forgeax-engine/apps/parity/case/manifest.json',
    'vendor/forgeax-voxel/packages/voxel/src/runtime.ts',
    'dist/plugin.mjs',
    'dist/shared.mjs',
  ])('rejects changed retained bytes: %s', async (name) => {
    const { root, inventory } = await fixture();
    const path = resolve(root, name);
    const expected = inventory.sourceInputs.get(path);
    await writeFile(path, 'changed bytes');
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: {
        sourcePath: path,
        cause: { reason: 'source changed during plugin compilation', expected },
      },
    });
    expect(inventory.sourceInputs.get(path)).toBe(expected);
  });

  it.each([
    'added.wgsl',
    'assets/added.ts',
    'new-lock.yaml',
    'vendor/forgeax-engine/added.json',
  ])('rejects added authority before reading contents: %s', async (name) => {
    const { root, inventory } = await fixture();
    const path = resolve(root, name);
    await writeFile(path, 'added bytes');
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: { sourcePath: path, cause: { reason: 'source added during plugin compilation' } },
    });
    expect(observation.reads.size).toBe(0);
  });

  it.each([
    'assets/helper.ts',
    'dist/plugin.mjs',
  ])('rejects deleted retained input: %s', async (name) => {
    const { root, inventory } = await fixture();
    await rm(resolve(root, name));
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps root aliases equivalent without skipping any content check', async () => {
    const { root, inventory } = await fixture();
    const parent = await mkdtemp(resolve(tmpdir(), 'forgeax-source-alias-'));
    temporary.push(parent);
    const alias = resolve(parent, 'alias');
    await symlink(root, alias, 'dir');
    await expect(assertPluginSourceInputs(inventory, alias)).resolves.toBeUndefined();
    expect([...observation.reads.values()]).toEqual([...inventory.sourceInputs].map(() => 1));
  });

  it('keeps disposable files ignored while retaining explicitly imported dist files', async () => {
    const { root, inventory } = await fixture();
    await writeFile(resolve(root, '.forgeax/catalog.json'), '{"disposable":2}');
    await writeFile(resolve(root, 'dist/unrelated.mjs'), 'not imported');
    await expect(assertPluginSourceInputs(inventory, root)).resolves.toBeUndefined();
    expect(observation.reads.has(resolve(root, '.forgeax/catalog.json'))).toBe(false);
    expect(observation.reads.has(resolve(root, 'dist/unrelated.mjs'))).toBe(false);
    expect(observation.reads.get(resolve(root, 'dist/shared.mjs'))).toBe(1);
  });

  it('rejects a content write after path discovery and before the final read', async () => {
    const { root, inventory } = await fixture();
    const path = resolve(root, 'assets/helper.ts');
    let visits = 0;
    observation.afterRealpath = async (actual) => {
      if (actual === path && ++visits === 2) await writeFile(path, 'changed after discovery');
    };
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: { sourcePath: path, cause: { reason: 'source changed during plugin compilation' } },
    });
  });

  it('rejects canonical alias collisions caused by path replacement during enumeration', async () => {
    const { root } = await fixture();
    // Freeze distinct paths with identical initial bytes. readdir obtains both file Dirents.
    await writeFile(resolve(root, 'assets/other.ts'), 'export const value = 1;');
    const inventory = await discoverPluginAssets({ root, assetRoots: ['assets'] });
    const names = await readdir(resolve(root, 'assets'));
    expect(names).toHaveLength(2);
    const [firstName, secondName] = names;
    if (firstName === undefined || secondName === undefined)
      throw new Error('two saved file Dirents required');
    const first = resolve(root, 'assets', firstName);
    const second = resolve(root, 'assets', secondName);
    observation.reads.clear();
    let replaced = false;
    observation.afterRealpath = async (path) => {
      if (path !== first || replaced) return;
      replaced = true;
      await writeFile(first, 'export const value = 2;');
      await rm(second);
      await symlink(first, second);
    };
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: {
        sourcePath: first,
        cause: { reason: 'source path alias changed during plugin compilation', path: second },
      },
    });
    expect(observation.reads.get(first)).toBeUndefined();
  });

  it('preserves added-input precedence over an existing changed input', async () => {
    const { root, inventory } = await fixture();
    await writeFile(resolve(root, 'assets/helper.ts'), 'changed');
    const path = resolve(root, 'added.wgsl');
    await writeFile(path, 'added');
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'plugin-bootstrap-failed',
      detail: { sourcePath: path, cause: { reason: 'source added during plugin compilation' } },
    });
  });

  it('preserves missing retained-path precedence over an added input', async () => {
    const { root, inventory } = await fixture();
    await rm(resolve(root, 'assets/helper.ts'));
    await writeFile(resolve(root, 'added.wgsl'), 'added');
    await expect(assertPluginSourceInputs(inventory, root)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

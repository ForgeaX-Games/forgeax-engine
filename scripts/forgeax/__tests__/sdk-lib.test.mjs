import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertNoRetiredPackageFiles,
  normalizePackageArchive,
  normalizePnpmStore,
} from '../sdk-lib.mjs';

const tempRoots = [];
const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(dirname(new URL(import.meta.url).pathname), '../../..');

async function writeIndex(name, value) {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-lib-'));
  tempRoots.push(root);
  const indexRoot = join(root, 'v11', 'index', 'aa');
  await mkdir(indexRoot, { recursive: true });
  const path = join(indexRoot, name);
  await writeFile(path, JSON.stringify(value));
  return { root, path };
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('normalizePnpmStore', () => {
  it('removes empty sideEffects metadata whose deps key is not reproducible', async () => {
    const { root, path } = await writeIndex('empty.json', {
      checkedAt: 123,
      name: '@forgeax/engine-fbx',
      sideEffects: { 'darwin;arm64;node26;deps=volatile': {} },
    });

    await normalizePnpmStore(root);

    await expect(readFile(path, 'utf8')).resolves.toBe(
      '{"checkedAt":0,"name":"@forgeax/engine-fbx"}\n',
    );
  });

  it('keeps sideEffects metadata when it carries installed files', async () => {
    const { root, path } = await writeIndex('non-empty.json', {
      name: 'esbuild',
      sideEffects: {
        'darwin;arm64;node26;deps=stable': {
          added: { 'bin/esbuild': { checkedAt: 123, mode: 493 } },
        },
      },
    });

    await normalizePnpmStore(root);

    await expect(readFile(path, 'utf8')).resolves.toBe(
      '{"name":"esbuild","sideEffects":{"darwin;arm64;node26;deps=stable":{"added":{"bin/esbuild":{"checkedAt":0,"mode":493}}}}}\n',
    );
  });
});

describe('normalizePackageArchive', () => {
  it('projects one release version into package identity and internal dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-package-test-'));
    tempRoots.push(root);
    await mkdir(join(root, 'package'));
    await writeFile(
      join(root, 'package', 'package.json'),
      `${JSON.stringify({
        name: '@forgeax/engine-example',
        version: '0.0.0',
        dependencies: { '@forgeax/engine-types': '0.0.0', zod: '4.3.6' },
      })}\n`,
    );
    const archive = join(root, 'example.tgz');
    await execFileAsync('tar', ['-czf', archive, '-C', root, 'package']);

    await normalizePackageArchive(archive, execFileAsync, { releaseVersion: '1.2.3' });

    const { stdout } = await execFileAsync('tar', ['-xOf', archive, 'package/package.json']);
    expect(JSON.parse(stdout)).toMatchObject({
      version: '1.2.3',
      dependencies: { '@forgeax/engine-types': '1.2.3', zod: '4.3.6' },
    });
  });

  it('preserves a pnpm content-addressed path that needs a PAX header', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-package-pax-test-'));
    tempRoots.push(root);
    await mkdir(join(root, 'package'));
    await writeFile(
      join(root, 'package', 'package.json'),
      '{"name":"@forgeax/engine-sdk","version":"1.2.3"}\n',
    );
    const hash = 'a'.repeat(128);
    const content = join(root, 'package', 'sdk', 'store', 'pnpm', 'v11', 'files', '00', hash);
    await mkdir(join(content, '..'), { recursive: true });
    await writeFile(content, 'content\n');
    const archive = join(root, 'sdk.tgz');
    await execFileAsync('tar', ['-czf', archive, '-C', root, 'package']);

    await normalizePackageArchive(archive, execFileAsync);

    const { stdout } = await execFileAsync('tar', [
      '-xOf',
      archive,
      `package/sdk/store/pnpm/v11/files/00/${hash}`,
    ]);
    expect(stdout).toBe('content\n');
  });
});

describe('assertNoRetiredPackageFiles', () => {
  it('rejects a deleted entry left behind by an incremental package build', () => {
    expect(() =>
      assertNoRetiredPackageFiles('@forgeax/engine-vite-plugin-pack', [
        'package/dist/index.mjs',
        'package/dist/runtime.mjs',
      ]),
    ).toThrow('sdk-retired-package-file: @forgeax/engine-vite-plugin-pack: dist/runtime.mjs');
  });

  it('accepts the clean package output inventory', () => {
    expect(() =>
      assertNoRetiredPackageFiles('@forgeax/engine-vite-plugin-pack', [
        'dist/index.mjs',
        'dist/runtime-diagnostics.d.ts',
      ]),
    ).not.toThrow();
  });
});

describe('canonical kit output override', () => {
  it('keeps the package-owned receipt unchanged when an SDK build uses a staging output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-sdk-canonical-kit-test-'));
    tempRoots.push(root);
    const packageKit = join(repositoryRoot, 'packages/preview/assets/canonical-kit');
    const receipt = join(packageKit, 'cook-receipt.json');
    const before = await readFile(receipt, 'utf8');
    const source = join(root, 'sky.hdr');
    const meta = join(root, 'sky.hdr.meta.json');
    await writeFile(source, Buffer.from('deterministic-canonical-kit-fixture\n'));
    await writeFile(meta, `${JSON.stringify({ guid: 'fixture-canonical-kit-guid' })}\n`);
    const output = join(root, 'canonical-kit');

    await execFileAsync(
      process.execPath,
      [join(repositoryRoot, 'packages/preview/scripts/build-canonical-kit.mjs'), source, meta],
      {
        cwd: repositoryRoot,
        env: { ...process.env, FORGEAX_CANONICAL_KIT_OUTPUT: output },
      },
    );

    await expect(readFile(receipt, 'utf8')).resolves.toBe(before);
    await expect(readFile(join(output, 'cook-receipt.json'), 'utf8')).resolves.toContain(
      'packages/preview/scripts/build-canonical-kit.mjs',
    );
  });
});

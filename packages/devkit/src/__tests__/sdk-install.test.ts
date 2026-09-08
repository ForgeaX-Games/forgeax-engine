import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sdkInstallCommand } from '../sdk-install.js';

const roots: string[] = [];
const originalClient = process.env.FORGEAX_NPM_CLIENT;
const originalFixture = process.env.FORGEAX_TEST_SDK_CARRIER;

afterEach(async () => {
  process.env.FORGEAX_NPM_CLIENT = originalClient;
  process.env.FORGEAX_TEST_SDK_CARRIER = originalFixture;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-sdk-install-test-'));
  roots.push(root);
  const sdk = resolve(root, 'carrier');
  const client = resolve(root, 'npm-client');
  await mkdir(resolve(sdk, 'bin'), { recursive: true });
  await writeFile(
    resolve(sdk, 'sdk-manifest.json'),
    `${JSON.stringify({ sdkVersion: '1.2.3' })}\n`,
  );
  await writeFile(resolve(sdk, 'bin', 'forgeax.mjs'), 'export {};\n');
  await writeFile(
    client,
    '#!/bin/sh\n' +
      'prefix=""\n' +
      'previous=""\n' +
      'for value in "$@"; do\n' +
      '  if [ "$previous" = "--prefix" ]; then prefix="$value"; fi\n' +
      '  previous="$value"\n' +
      'done\n' +
      'target="$prefix/node_modules/@forgeax/engine-sdk/sdk"\n' +
      'mkdir -p "$target"\n' +
      'cp -R "$FORGEAX_TEST_SDK_CARRIER/." "$target/"\n',
  );
  await chmod(client, 0o755);
  process.env.FORGEAX_NPM_CLIENT = client;
  process.env.FORGEAX_TEST_SDK_CARRIER = sdk;
  return root;
}

describe('sdkInstallCommand', () => {
  it('installs an exact npm SDK carrier into an absent target', async () => {
    const root = await fixture();
    const target = resolve(root, 'installed-sdk');

    const result = await sdkInstallCommand({ root: target, version: '1.2.3' });

    expect(result).toEqual({
      ok: true,
      value: {
        root: target,
        sdkVersion: '1.2.3',
        source: '@forgeax/engine-sdk',
        next: { cwd: target, argv: ['node', './bin/forgeax.mjs', 'init'] },
      },
    });
    expect(JSON.parse(await readFile(resolve(target, 'sdk-manifest.json'), 'utf8'))).toEqual({
      sdkVersion: '1.2.3',
    });
    expect(await readFile(resolve(target, 'bin', 'forgeax.mjs'), 'utf8')).toBe('export {};\n');
    expect((await readdir(root)).filter((name) => name.includes('forgeax-sdk-'))).toEqual([]);
  });

  it('does not overwrite a non-empty directory', async () => {
    const root = await fixture();
    const target = resolve(root, 'existing');
    await mkdir(target);
    await writeFile(resolve(target, 'keep.txt'), 'keep\n');

    const result = await sdkInstallCommand({ root: target, version: '1.2.3' });

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'sdk-target-not-empty' }),
    });
    expect(await readFile(resolve(target, 'keep.txt'), 'utf8')).toBe('keep\n');
  });
});

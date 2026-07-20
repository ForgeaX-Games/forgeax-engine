import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadAssetConfig } from '../config.js';

describe('loadAssetConfig SSOT (w8 / AC-13)', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'forgeax-test-loadAssetConfig-'));
  });

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('missing package.json returns default roots + empty paths', () => {
    const result = loadAssetConfig(join(tmpDir, 'nonexistent'));
    expect(result.roots).toEqual([join(join(tmpDir, 'nonexistent'), 'assets')]);
    expect(result.paths).toEqual({});
  });

  it('package.json without forgeax.assets returns default', async () => {
    const dir = join(tmpDir, 'no-forgeax');
    await mkdir(dir);
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'test' }));
    const result = loadAssetConfig(dir);
    expect(result.roots).toEqual([join(dir, 'assets')]);
    expect(result.paths).toEqual({});
  });

  it('reads forgeax.assets.roots from package.json', async () => {
    const dir = join(tmpDir, 'with-roots');
    await mkdir(dir);
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'test',
        forgeax: { assets: { roots: ['my-assets', 'more'] } },
      }),
    );
    const result = loadAssetConfig(dir);
    expect(result.roots).toEqual([join(dir, 'my-assets'), join(dir, 'more')]);
    expect(result.paths).toEqual({});
  });

  it('empty forgeax.assets.roots array falls back to default', async () => {
    const dir = join(tmpDir, 'empty-roots');
    await mkdir(dir);
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'test',
        forgeax: { assets: { roots: [] } },
      }),
    );
    const result = loadAssetConfig(dir);
    expect(result.roots).toEqual([join(dir, 'assets')]);
  });

  it('reads forgeax.assets.paths with cwd-relative resolution', async () => {
    const dir = join(tmpDir, 'with-paths');
    await mkdir(dir);
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'test',
        forgeax: {
          assets: {
            paths: {
              shared: 'lib/assets',
              vendor: '../vendor-assets',
            },
          },
        },
      }),
    );
    const result = loadAssetConfig(dir);
    expect(result.paths).toEqual({
      shared: join(dir, 'lib/assets'),
      vendor: join(dir, '../vendor-assets'),
    });
  });

  it('paths absent defaults to empty object', async () => {
    const dir = join(tmpDir, 'roots-only');
    await mkdir(dir);
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'test',
        forgeax: { assets: { roots: ['a'] } },
      }),
    );
    const result = loadAssetConfig(dir);
    expect(result.paths).toEqual({});
  });

  it('non-string path values are skipped', async () => {
    const dir = join(tmpDir, 'bad-paths');
    await mkdir(dir);
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({
        name: 'test',
        forgeax: {
          assets: {
            paths: {
              good: 'lib/a',
              badNum: 42,
              badBool: true,
            },
          },
        },
      }),
    );
    const result = loadAssetConfig(dir);
    expect(result.paths).toEqual({ good: join(dir, 'lib/a') });
  });
});

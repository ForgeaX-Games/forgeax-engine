import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assetAddCommand, assetListCommand } from '../assets.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-assets-'));
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      `${JSON.stringify({ id: 'game', name: 'Game', schemaVersion: '1.0.0', entry: 'main.ts', plugins: [{ id: 'gameplay', name: './main.ts' }] })}\n`,
    ),
    writeFile(resolve(root, 'package.json'), '{"name":"game"}\n'),
    writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n'),
  ]);
  await (await import('node:fs/promises')).mkdir(resolve(root, 'assets'));
  await writeFile(resolve(root, 'assets', 'hero.png'), new Uint8Array([1, 2, 3]));
  return root;
}

describe('asset commands', () => {
  it('adds an image once and reuses its GUID', async () => {
    const root = await fixture();
    const first = await assetAddCommand({ root, path: 'assets/hero.png' });
    expect(first.ok).toBe(true);
    const before = await readFile(resolve(root, 'assets', 'hero.png.meta.json'), 'utf8');
    const second = await assetAddCommand({ root, path: 'assets/hero.png' });
    expect(second.ok).toBe(true);
    expect(await readFile(resolve(root, 'assets', 'hero.png.meta.json'), 'utf8')).toBe(before);
    const listed = await assetListCommand({ root });
    expect(listed).toEqual({
      ok: true,
      value: [expect.objectContaining({ kind: 'texture', name: 'texture' })],
    });
  });

  it('does not write a sidecar during dry-run', async () => {
    const root = await fixture();
    const result = await assetAddCommand({ root, path: 'assets/hero.png', dryRun: true });
    expect(result.ok).toBe(true);
    await expect(readFile(resolve(root, 'assets', 'hero.png.meta.json'))).rejects.toThrow();
  });
});

describe('authored Pack asset add', () => {
  async function packFixture() {
    const root = await fixture();
    const pack = JSON.parse(
      await readFile(
        new URL(
          '../../../../templates/game-default/assets/multi-material-target.pack.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    await writeFile(resolve(root, 'assets/world.pack.json'), JSON.stringify(pack));
    return { root, pack };
  }
  it('imports the authored identities without generating a sidecar', async () => {
    const { root, pack } = await packFixture();
    const result = await assetAddCommand({ root, path: 'assets/world.pack.json' });
    expect(result, JSON.stringify(result)).toMatchObject({
      ok: true,
      value: {
        assets: [
          {
            subAssets: pack.assets.map((a: { guid: string; kind: string }) => ({
              guid: a.guid,
              kind: a.kind,
            })),
          },
        ],
      },
    });
    await expect(readFile(resolve(root, 'assets/world.pack.json.meta.json'))).rejects.toThrow();
    expect((await assetListCommand({ root })).ok).toBe(true);
  });
  it('rejects catalog GUID collisions instead of silently remapping', async () => {
    const { root, pack } = await packFixture();
    await writeFile(resolve(root, 'assets/duplicate.pack.json'), JSON.stringify(pack));
    expect((await assetAddCommand({ root, path: 'assets/world.pack.json' })).ok).toBe(false);
  });
  it('rejects missing external artifacts', async () => {
    const { root, pack } = await packFixture();
    pack.assets[0].artifacts = {
      geometry: { path: 'absent.bin', mediaType: 'application/octet-stream' },
    };
    await writeFile(resolve(root, 'assets/world.pack.json'), JSON.stringify(pack));
    expect((await assetAddCommand({ root, path: 'assets/world.pack.json' })).ok).toBe(false);
  });
  it('rejects corrupted artifact bytes even when the path exists', async () => {
    const { root, pack } = await packFixture();
    pack.assets[0].artifacts = {
      geometry: {
        path: 'data.bin',
        mediaType: 'application/octet-stream',
        byteLength: 3,
        integrity: { algorithm: 'sha256', digest: '0'.repeat(64) },
      },
    };
    await writeFile(resolve(root, 'assets/data.bin'), 'abc');
    await writeFile(resolve(root, 'assets/world.pack.json'), JSON.stringify(pack));
    expect(await assetAddCommand({ root, path: 'assets/world.pack.json' })).toMatchObject({
      ok: false,
      error: { code: 'pack-import-artifact-integrity' },
    });
  });
});

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
      `${JSON.stringify({ id: 'game', name: 'Game', entry: 'main.ts' })}\n`,
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

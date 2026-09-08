import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pluginInstallCommand, pluginUninstallCommand } from '../plugin-authoring.js';

async function project(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-plugin-authoring-'));
  await Promise.all([
    writeFile(
      resolve(root, 'forge.json'),
      `${JSON.stringify({
        id: 'game',
        name: 'Game',
        schemaVersion: '1.0.0',
        entry: 'main.ts',
        plugins: [{ id: 'base', name: './main.ts', realm: 'engine' }],
      })}\n`,
    ),
    writeFile(resolve(root, 'main.ts'), 'export default () => undefined;\n'),
  ]);
  return root;
}

describe('plugin authoring transaction', () => {
  it('installs and uninstalls a local module through forge.json Entry identity', async () => {
    const root = await project();
    const installed = await pluginInstallCommand({
      root,
      id: 'feature',
      module: './feature.ts',
      realm: 'engine',
    });
    expect(installed.ok).toBe(true);
    let manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')) as {
      plugins: Array<{ id: string; name: string }>;
    };
    expect(manifest.plugins).toContainEqual(
      expect.objectContaining({ id: 'feature', name: './feature.ts' }),
    );

    const uninstalled = await pluginUninstallCommand({ root, id: 'feature' });
    expect(uninstalled.ok).toBe(true);
    manifest = JSON.parse(await readFile(resolve(root, 'forge.json'), 'utf8')) as typeof manifest;
    expect(manifest.plugins.map((entry) => entry.id)).toEqual(['base']);
  });

  it('does not mutate the manifest when the Entry id conflicts', async () => {
    const root = await project();
    const before = await readFile(resolve(root, 'forge.json'), 'utf8');
    const result = await pluginInstallCommand({ root, id: 'base', module: './other.ts' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('plugin-entry-id-conflict');
    expect(await readFile(resolve(root, 'forge.json'), 'utf8')).toBe(before);
  });
});

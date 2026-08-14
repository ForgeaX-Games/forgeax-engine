import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProjectFacts } from '../project.js';

async function project(forge: unknown, manifest: unknown): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-project-'));
  await Promise.all([
    writeFile(resolve(root, 'forge.json'), `${JSON.stringify(forge)}\n`),
    writeFile(resolve(root, 'package.json'), `${JSON.stringify(manifest)}\n`),
    writeFile(resolve(root, 'main.ts'), 'export async function bootstrap() {}\n'),
  ]);
  return root;
}

describe('readProjectFacts', () => {
  it('derives defaults from the existing authorities', async () => {
    const root = await project(
      {
        id: 'game',
        name: 'Game',
        entry: 'main.ts',
        physics: '3d',
        defaultScene: 'c5def54a-ed2b-4fa1-9535-8e1b18cb9f5b',
      },
      { name: 'game', forgeax: {} },
    );
    const result = await readProjectFacts(root);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        root,
        id: 'game',
        name: 'Game',
        entry: 'main.ts',
        physics: '3d',
        defaultScene: 'c5def54a-ed2b-4fa1-9535-8e1b18cb9f5b',
        assetRoots: ['assets'],
      }),
    });
  });

  it('fails when the declared entry is missing', async () => {
    const root = await project({ id: 'game', name: 'Game', entry: 'missing.ts' }, { name: 'game' });
    const result = await readProjectFacts(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('project-entry-missing');
  });
});

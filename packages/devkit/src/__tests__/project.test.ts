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
        schemaVersion: '1.0.0',
        entry: 'main.ts',
        plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
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
        plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
        physics: '3d',
        defaultScene: 'c5def54a-ed2b-4fa1-9535-8e1b18cb9f5b',
        assetRoots: ['assets'],
      }),
    });
  });

  it('fails when the declared entry is missing', async () => {
    const root = await project(
      {
        id: 'game',
        name: 'Game',
        schemaVersion: '1.0.0',
        entry: 'missing.ts',
        plugins: [{ id: 'gameplay', name: './missing.ts', realm: 'engine' }],
      },
      { name: 'game' },
    );
    const result = await readProjectFacts(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('project-entry-missing');
  });

  it('derives the schema-owned bootstrap entry when no plugin claims the entry module', async () => {
    const root = await project(
      {
        id: 'game',
        name: 'Game',
        schemaVersion: '1.0.0',
        entry: 'main.ts',
      },
      { name: 'game' },
    );
    const result = await readProjectFacts(root);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        bootstrapEntry: 'main.ts',
        plugins: [],
      }),
    });
  });

  it('preserves project-owned asset importer and public directory declarations', async () => {
    const root = await project(
      {
        id: 'game',
        name: 'Game',
        schemaVersion: '1.0.0',
        entry: 'main.ts',
        plugins: [{ id: 'gameplay', name: './main.ts', realm: 'engine' }],
      },
      {
        name: 'game',
        forgeax: {
          assets: {
            roots: ['assets'],
            importers: ['./assets/plugins/importer.ts#factory'],
            publicDir: 'assets/public',
          },
        },
      },
    );
    const result = await readProjectFacts(root);
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        assetRoots: ['assets'],
        assetImporters: ['./assets/plugins/importer.ts#factory'],
        assetPublicDir: 'assets/public',
      }),
    });
  });

  it('rejects realm Entries the standalone host cannot activate', async () => {
    const root = await project(
      {
        id: 'game',
        name: 'Game',
        schemaVersion: '1.0.0',
        entry: 'main.ts',
        plugins: [{ id: 'host-tools', name: './main.ts', realm: 'host' }],
      },
      { name: 'game' },
    );
    const result = await readProjectFacts(root);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('project-plugin-realm-unsupported');
  });
});

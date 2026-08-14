import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { verifyDist, writeDistManifest } from '../dist.js';
import type { ProjectFacts } from '../types.js';

describe('dist closure', () => {
  it('detects artifact tampering', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-dist-'));
    const dist = resolve(root, 'dist');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(resolve(dist, 'shaders'), { recursive: true });
    await Promise.all([
      writeFile(resolve(dist, 'index.html'), '<canvas></canvas>'),
      writeFile(resolve(dist, 'pack-index.json'), '[]'),
      writeFile(resolve(dist, 'shaders/manifest.json'), '{}'),
    ]);
    const facts: ProjectFacts = {
      root,
      id: 'game',
      name: 'Game',
      entry: 'main.ts',
      assetRoots: ['assets'],
      packageJson: {},
    };
    await writeDistManifest(facts, '/');
    expect((await verifyDist(dist)).ok).toBe(true);
    await writeFile(resolve(dist, 'index.html'), 'tampered');
    const result = await verifyDist(dist);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('dist-artifact-mismatch');
  });

  it('rejects files outside the declared closure', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-devkit-dist-'));
    const dist = resolve(root, 'dist');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(resolve(dist, 'shaders'), { recursive: true });
    await Promise.all([
      writeFile(resolve(dist, 'index.html'), '<canvas></canvas>'),
      writeFile(resolve(dist, 'pack-index.json'), '[]'),
      writeFile(resolve(dist, 'shaders/manifest.json'), '{}'),
    ]);
    const facts: ProjectFacts = {
      root,
      id: 'game',
      name: 'Game',
      entry: 'main.ts',
      assetRoots: ['assets'],
      packageJson: {},
    };
    await writeDistManifest(facts, '/');
    await writeFile(resolve(dist, 'foreign.js'), 'export {};');
    const result = await verifyDist(dist);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('dist-artifact-undeclared');
  });
});

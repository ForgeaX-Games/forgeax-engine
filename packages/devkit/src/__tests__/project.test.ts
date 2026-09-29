import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readProjectFacts } from '../project.js';

const temporary: string[] = [];
const guid = '01900000-0000-7000-8000-000000000100';
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function project(fields: object = {}, packageFields: object = {}) {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-project-'));
  temporary.push(root);
  await writeFile(
    resolve(root, 'forge.json'),
    JSON.stringify({ id: 'game', name: 'Game', schemaVersion: '3.0.0', roots: {}, ...fields }),
  );
  await writeFile(
    resolve(root, 'package.json'),
    JSON.stringify({ name: 'game', ...packageFields }),
  );
  return root;
}
describe('readProjectFacts', () => {
  it('reads root references without resolving or executing runtime code', async () => {
    const roots = { engine: guid, host: guid, build: guid };
    const root = await project({ roots });
    expect(await readProjectFacts(root)).toMatchObject({
      ok: true,
      value: { root, roots, assetRoots: ['assets'] },
    });
  });
  it('canonicalizes symlinked paths before generating host paths', async () => {
    const root = await project();
    const parent = await mkdtemp(resolve(tmpdir(), 'forgeax-alias-'));
    temporary.push(parent);
    await symlink(root, resolve(parent, 'game'), 'dir');
    expect(await readProjectFacts(resolve(parent, 'game'))).toMatchObject({
      ok: true,
      value: { root: await realpath(root) },
    });
  });
  it('rejects the removed project authoring paths', async () => {
    for (const fields of [{ plugins: [] }, { defaultScene: guid }, { schemaVersion: '2.0.0' }]) {
      expect(await readProjectFacts(await project(fields))).toMatchObject({
        ok: false,
        error: { code: 'project-manifest-invalid' },
      });
    }
  });
  it('uses the fixed assets content root and supports an empty project', async () => {
    const root = await project();
    await mkdir(resolve(root, 'assets'));
    expect(await readProjectFacts(root)).toMatchObject({
      ok: true,
      value: { roots: {}, assetRoots: ['assets'] },
    });
  });
  it('ships game-3d with asset-owned host and engine roots', async () => {
    const result = await readProjectFacts(
      resolve(import.meta.dirname, '../../../../templates/game-3d'),
    );
    expect(result).toMatchObject({
      ok: true,
      value: { roots: { frontend: expect.any(String), engine: expect.any(String) } },
    });
    if (result.ok) {
      expect(result.value).not.toHaveProperty('plugins');
      expect(result.value).not.toHaveProperty('defaultScene');
    }
  });
});

import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createScriptablePackSourceSnapshot } from '../scriptable-pack-source-snapshot.js';

const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pack-source-snapshot-')));
  roots.push(root);
  const source = join(root, 'asset.pack.ts');
  const dependency = join(root, 'shape.js');
  await writeFile(source, "export { shape } from './shape.js';");
  await writeFile(dependency, 'export const shape = 1;');
  return { root, source, dependency };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('shares one immutable input across roots and refuses a changed generation', async () => {
  const { source, dependency } = await fixture();
  const snapshot = createScriptablePackSourceSnapshot();
  const first = await snapshot.inventory(source);
  const before = await stat(dependency);
  await writeFile(dependency, 'export const shape = 2;');
  await utimes(dependency, before.atime, before.mtime);
  expect(await snapshot.inventory(source)).toEqual(first);
  expect(await snapshot.readText(dependency)).toBe('export const shape = 1;');
  expect(await snapshot.verify()).toMatchObject({
    ok: false,
    error: { code: 'pack-source-revision-conflict' },
  });
  expect(await createScriptablePackSourceSnapshot().inventory(source)).not.toEqual(first);
});

it('captures failed resolution probes, deletion and symlink rebinding', async () => {
  const { root, source, dependency } = await fixture();
  const snapshot = createScriptablePackSourceSnapshot();
  await snapshot.inventory(source);
  await writeFile(join(root, 'shape.ts'), 'export const shape = 3;');
  expect((await snapshot.verify()).ok).toBe(false);
  const next = createScriptablePackSourceSnapshot();
  expect((await next.inventory(source)).map((entry) => entry.path)).toContain(
    join(root, 'shape.ts'),
  );
  await unlink(join(root, 'shape.ts'));
  expect((await next.verify()).ok).toBe(false);
  const alias = join(root, 'alias.js');
  await symlink(dependency, alias);
  const linked = createScriptablePackSourceSnapshot();
  await linked.readText(alias);
  await unlink(alias);
  await symlink(source, alias);
  expect((await linked.verify()).ok).toBe(false);
});

it('revalidates custom resolution and never mistakes directory metadata for source identity', async () => {
  const { root, source, dependency } = await fixture();
  const other = join(root, 'other.js');
  await writeFile(other, await readFile(dependency));
  let target = dependency;
  const resolveImport = vi.fn(async () => target);
  const snapshot = createScriptablePackSourceSnapshot();
  await snapshot.inventory(source, undefined, resolveImport);
  await snapshot.inventory(source, undefined, resolveImport);
  expect(resolveImport).toHaveBeenCalledTimes(1);
  expect((await snapshot.verify()).ok).toBe(true);
  target = other;
  expect((await snapshot.verify()).ok).toBe(false);
});

it('keeps captured module text usable after source deletion and isolates returned records', async () => {
  const { source, dependency } = await fixture();
  const snapshot = createScriptablePackSourceSnapshot();
  const captured = await snapshot.moduleSources(source);
  await unlink(dependency);
  expect(captured[dependency]).toBe('export const shape = 1;');
  captured[dependency] = 'corrupted consumer copy';
  expect((await snapshot.moduleSources(source))[dependency]).toBe('export const shape = 1;');
  expect((await snapshot.verify()).ok).toBe(false);
});

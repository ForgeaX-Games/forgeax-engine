// @perf-budget-skip: intentional ScriptablePack CLI integration gate.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { runCliAsset } from '../cli-asset.js';
import {
  createScriptablePackSourceSnapshot,
  inventoryScriptablePackSource,
  loadScriptablePack,
} from '../scriptable-pack-node.js';

describe('ScriptablePack CLI Meta inspection', () => {
  it('executes captured module bytes when the source changes before worker loading', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'forgeax-pack-captured-')));
    try {
      const source = join(root, 'shape.pack.ts'),
        helper = join(root, 'helper.ts');
      await writeFile(helper, 'export const count = 7;');
      await writeFile(
        source,
        `import { count } from './helper.js';
        export default { schemaVersion: '2.0.0',
          packageId: new Uint8Array([1,159,250,151,139,57,122,210,132,204,39,50,104,89,26,180]),
          build() { return { ok: true, value: { scene: { kind: 'scene', entities: [], count } } }; }
        };`,
      );
      const sourceSnapshot = createScriptablePackSourceSnapshot();
      await sourceSnapshot.inventory(source);
      await writeFile(helper, 'export const count = 9;');
      const loaded = await loadScriptablePack(source, { sourceSnapshot });
      if (!loaded.ok) throw loaded.error;
      const built = await loaded.value.build({
        packageId: loaded.value.packageId,
        values: {},
        readByGuid: async () => err('unused'),
      });
      expect(built).toMatchObject({ ok: true, value: { scene: { count: 7 } } });
      expect(await sourceSnapshot.verify()).toMatchObject({
        ok: false,
        error: { code: 'pack-source-revision-conflict' },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes TypeScript re-export closures using JavaScript specifiers and directory indexes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-ts-closure-'));
    try {
      await mkdir(join(root, 'nested'));
      await writeFile(join(root, 'nested/index.ts'), 'export const count: number = 7;');
      await writeFile(join(root, 'barrel.ts'), "export * from './nested';");
      const source = join(root, 'shape.pack.ts');
      await writeFile(
        source,
        `import { count } from './barrel.js';
        export default { schemaVersion: '2.0.0',
          packageId: new Uint8Array([1,159,250,151,139,57,122,210,132,204,39,50,104,89,26,180]),
          build() { return { ok: true, value: { 'scene/main': { kind: 'scene', entities: [], mounts: [], count } } }; }
        };`,
      );
      const inventory = await inventoryScriptablePackSource(source);
      expect(inventory.map((entry) => entry.path)).toEqual(
        expect.arrayContaining([
          await realpath(join(root, 'barrel.ts')),
          await realpath(join(root, 'nested/index.ts')),
        ]),
      );
      const loaded = await loadScriptablePack(source);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw loaded.error;
      const built = await loaded.value.build({
        packageId: loaded.value.packageId,
        values: {},
        readByGuid: async () => err('unused'),
      });
      expect(built).toMatchObject({
        ok: true,
        value: { 'scene/main': { kind: 'scene', count: 7 } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('executes and inventories a relative TypeScript dependency with a dotted basename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-pack-dotted-closure-'));
    try {
      const dependency = join(root, 'facade-grammar.pack-lib.ts');
      await writeFile(dependency, 'export const count: number = 7;');
      const source = join(root, 'shape.pack.ts');
      await writeFile(
        source,
        `import { count } from './facade-grammar.pack-lib';
        export default { schemaVersion: '2.0.0',
          packageId: new Uint8Array([1,159,250,151,139,57,122,210,132,204,39,50,104,89,26,180]),
          build() { return { ok: true, value: { 'scene/main': { kind: 'scene', entities: [], mounts: [], count } } }; }
        };`,
      );
      const inventory = await inventoryScriptablePackSource(source);
      expect(inventory.map((entry) => entry.path)).toContain(await realpath(dependency));
      const loaded = await loadScriptablePack(source);
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) throw loaded.error;
      const built = await loaded.value.build({
        packageId: loaded.value.packageId,
        values: {},
        readByGuid: async () => err('unused'),
      });
      expect(built).toMatchObject({
        ok: true,
        value: { 'scene/main': { kind: 'scene', count: 7 } },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('loads the definition without invoking build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-pack-'));
    try {
      const source = join(root, 'house.pack.mjs');
      await writeFile(
        source,
        `
        export default {
          schemaVersion: '2.0.0',
          packageId: new Uint8Array([1, 159, 250, 151, 139, 57, 122, 210, 132, 204, 39, 50, 104, 89, 26, 180]),
          build() { throw new Error('META_MUST_NOT_BUILD'); }
        };
      `,
      );
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCliAsset(['meta', source, '--json'], {
        stdoutWrite: (line) => stdout.push(line),
        stderrWrite: (line) => stderr.push(line),
        cwd: root,
      });
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(JSON.parse(stdout[0] ?? '{}')).toMatchObject({
        kind: 'scriptable-pack-source',
        source,
        packageId: '019ffa97-8b39-7ad2-84cc-273268591ab4',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

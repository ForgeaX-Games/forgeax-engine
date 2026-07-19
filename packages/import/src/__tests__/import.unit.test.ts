// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=2):
//   - packages/import/src/__tests__/import-runner.test.ts
//   - packages/import/src/__tests__/importer-registry.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import type { Asset, ImportContext, ImportedAsset, Importer } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { type RunImportMeta, runImport } from '../import-runner.js';
import { ImporterRegistry } from '../importer-registry.js';

function stubImporter(key: string): Importer {
  return { key, import: (_ctx: ImportContext): readonly ImportedAsset[] => [] };
}

{
  // ─── from import-runner.test.ts ───

  const GUID_A = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
  const GUID_B = '019e2cc6-0c86-79da-aa76-b0984c86d45d';
  const GUID_UNDECLARED = 'ffffffff-0c86-79da-aa76-b0984c86d45c';

  const MESH_POD = {
    kind: 'mesh' as const,
    vertices: new Float32Array(),
    indices: new Uint16Array(),
    attributes: {},
  } as unknown as Asset;

  function okFs(bytes = new Uint8Array([1, 2, 3])) {
    return {
      readSource: async () => ({ ok: true as const, value: bytes }),
    };
  }

  function failFs() {
    return {
      readSource: async () => ({ ok: false as const, error: new Error('ENOENT no such file') }),
    };
  }

  function meta(importer: string, guids: readonly string[]): RunImportMeta {
    return {
      importer,
      source: 'model.gltf',
      subAssets: guids.map((g, i) => ({ guid: g, sourceIndex: i, kind: 'mesh' })),
    };
  }

  function registryWith(
    key: string,
    impl: (ctx: ImportContext) => readonly ImportedAsset[] | Promise<readonly ImportedAsset[]>,
  ): ImporterRegistry {
    const reg = new ImporterRegistry();
    reg.register({ key, import: impl });
    return reg;
  }

  describe('import-runner.test.ts', () => {
    describe('import runner (w15 / w17)', () => {
      it('(a) happy path: produces a DDC pack with one row per produced asset', async () => {
        const reg = registryWith('gltf', () => [
          { guid: GUID_A, kind: 'mesh', payload: MESH_POD, refs: [] },
          { guid: GUID_B, kind: 'mesh', payload: MESH_POD, refs: [] },
        ]);
        const res = await runImport(meta('gltf', [GUID_A, GUID_B]), reg, okFs());
        expect(res.ok).toBe(true);
        if (res.ok && !('skipped' in res.value)) {
          expect(res.value.pack.kind).toBe('internal-text-package');
          expect(res.value.pack.assets.map((a) => a.guid)).toEqual([GUID_A, GUID_B]);
        }
      });

      it('(b) import-produced-no-assets: importer returns []', async () => {
        const reg = registryWith('gltf', () => []);
        const res = await runImport(meta('gltf', [GUID_A]), reg, okFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('import-produced-no-assets');
          expect(res.error.detail).toMatchObject({ missingGuids: [GUID_A] });
        }
      });

      it('(c) guid-mismatch: produced a GUID not declared in subAssets[]', async () => {
        const reg = registryWith('gltf', () => [
          { guid: GUID_UNDECLARED, kind: 'mesh', payload: MESH_POD, refs: [] },
        ]);
        const res = await runImport(meta('gltf', [GUID_A]), reg, okFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('guid-mismatch');
          expect(res.error.detail).toMatchObject({ unexpectedGuids: [GUID_UNDECLARED] });
        }
      });

      it('(d) import-produced-no-assets: a declared GUID is missing from the produced set', async () => {
        const reg = registryWith('gltf', () => [
          { guid: GUID_A, kind: 'mesh', payload: MESH_POD, refs: [] },
        ]);
        const res = await runImport(meta('gltf', [GUID_A, GUID_B]), reg, okFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('import-produced-no-assets');
          expect(res.error.detail).toMatchObject({ missingGuids: [GUID_B] });
        }
      });

      it('(e) importer-not-registered: no importer for meta.importer', async () => {
        const reg = new ImporterRegistry();
        reg.register({ key: 'image', import: () => [] });
        const res = await runImport(meta('gltf', [GUID_A]), reg, okFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('importer-not-registered');
          expect(res.error.detail).toMatchObject({
            importer: 'gltf',
            registeredImporters: ['image'],
          });
        }
      });

      it('(f) source-read-failed: readSource rejects', async () => {
        const reg = registryWith('gltf', () => [
          { guid: GUID_A, kind: 'mesh', payload: MESH_POD, refs: [] },
        ]);
        const res = await runImport(meta('gltf', [GUID_A]), reg, failFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('source-read-failed');
          expect(res.error.detail).toMatchObject({ source: 'model.gltf' });
        }
      });

      it('(g) import-internal-error: the importer throws', async () => {
        const reg = registryWith('gltf', () => {
          throw new Error('boom inside importer');
        });
        const res = await runImport(meta('gltf', [GUID_A]), reg, okFs());
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error.code).toBe('import-internal-error');
          expect(res.error.detail).toMatchObject({ reason: 'boom inside importer' });
        }
      });

      it('(h) reserved shader key is skipped (no DDC, no importer call)', async () => {
        const reg = new ImporterRegistry();
        const res = await runImport(meta('shader', [GUID_A]), reg, okFs());
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.value).toEqual({ skipped: 'shader' });
        }
      });

      it('(i) dispatch: the correct importer is invoked for meta.importer', async () => {
        let invoked = '';
        const reg = new ImporterRegistry();
        reg.register({
          key: 'gltf',
          import: () => {
            invoked = 'gltf';
            return [{ guid: GUID_A, kind: 'mesh', payload: MESH_POD, refs: [] }];
          },
        });
        reg.register({
          key: 'image',
          import: () => {
            invoked = 'image';
            return [{ guid: GUID_A, kind: 'texture', payload: MESH_POD, refs: [] }];
          },
        });
        await runImport(meta('image', [GUID_A]), reg, okFs());
        expect(invoked).toBe('image');
      });
    });
  });
}

{
  // ─── from importer-registry.test.ts ───

  describe('importer-registry.test.ts', () => {
    describe('ImporterRegistry (w14 / w17)', () => {
      it('register then get returns the registered importer', () => {
        const reg = new ImporterRegistry();
        const gltf = stubImporter('gltf');
        reg.register(gltf);
        expect(reg.get('gltf')).toBe(gltf);
      });

      it('get on an unregistered key returns undefined', () => {
        const reg = new ImporterRegistry();
        expect(reg.get('gltf')).toBeUndefined();
      });

      it('re-registering the same key is idempotent (last write wins, no throw)', () => {
        const reg = new ImporterRegistry();
        const first = stubImporter('gltf');
        const second = stubImporter('gltf');
        reg.register(first);
        expect(() => reg.register(second)).not.toThrow();
        expect(reg.get('gltf')).toBe(second);
        expect(reg.registeredImporters().filter((k) => k === 'gltf')).toHaveLength(1);
      });

      it('registeredImporters reflects insertion order', () => {
        const reg = new ImporterRegistry();
        reg.register(stubImporter('gltf'));
        reg.register(stubImporter('image'));
        expect(reg.registeredImporters()).toEqual(['gltf', 'image']);
      });

      it('fail-fast: register throws on empty key', () => {
        const reg = new ImporterRegistry();
        expect(() => reg.register({ key: '', import: () => [] })).toThrow(TypeError);
      });

      it('fail-fast: register throws when import is not a function', () => {
        const reg = new ImporterRegistry();
        expect(() =>
          reg.register({ key: 'gltf', import: undefined as unknown as Importer['import'] }),
        ).toThrow(TypeError);
      });
    });
  });
}

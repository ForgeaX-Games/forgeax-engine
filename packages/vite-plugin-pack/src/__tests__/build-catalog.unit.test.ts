// Consolidated by feat-20260609-test-pool-startup-reduction-merge-tiny-test-files
// biome-ignore-all lint/complexity/noUselessLoneBlockStatements: scope isolation between merged source files
//
// Source files (N=10):
//   - packages/vite-plugin-pack/src/__tests__/build-catalog-base-prefix.test.ts
//   - packages/vite-plugin-pack/src/__tests__/build-catalog-fail-fast.test.ts
//   - packages/vite-plugin-pack/src/__tests__/build-catalog-font.test.ts
//   - packages/vite-plugin-pack/src/__tests__/build-catalog-gltf-arm.test.ts
//   - packages/vite-plugin-pack/src/__tests__/build-catalog-gltf-texture.test.ts
//   - packages/vite-plugin-pack/src/__tests__/build-catalog-hdr-equirect.test.ts
//   - packages/vite-plugin-pack/src/__tests__/build-catalog-image-arm.test.ts
//   - packages/vite-plugin-pack/src/__tests__/build-catalog-name.test.ts
//   - packages/vite-plugin-pack/src/__tests__/build-import-hdr.test.ts
//   - packages/vite-plugin-pack/test/plugin-build.test.ts
//
// Paradigm: each block-scoped describe('<source-filename>.test.ts', ...) preserves
// source as ancestorTitles[0]. Top-level imports merged + deduped.

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveAssetName } from '@forgeax/engine-pack/name';
import type { PackIndexEntry } from '@forgeax/engine-types';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { build as viteBuild } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import packIndexSchemaJson from '../../schema/pack-index.schema.json' with { type: 'json' };
import { buildCatalog, buildCatalogStrict } from '../build-catalog.js';
import { pluginPack } from '../index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = join(HERE, '..', '..', '..', '..');

{
  // ─── from build-catalog-base-prefix.test.ts ───

  async function makeRootWithPack(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-base-'));
    const pack = {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: [
        { guid: '01890000-0000-7000-8000-aaaaaaaaaaaa', kind: 'material', payload: {}, refs: [] },
      ],
    };
    await writeFile(join(root, 'mat.pack.json'), JSON.stringify(pack), 'utf-8');
    return root;
  }

  describe('build-catalog-base-prefix.test.ts', () => {
    let root: string;
    beforeEach(async () => {
      root = await makeRootWithPack();
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('default base is root-absolute (no prefix)', async () => {
      const entries = await buildCatalog([root]);
      expect(entries.length).toBe(1);
      expect(entries[0]?.relativeUrl.startsWith('/')).toBe(true);
      expect(entries[0]?.relativeUrl.startsWith('/preview/')).toBe(false);
      expect(entries[0]?.relativeUrl.endsWith('/mat.pack.json')).toBe(true);
    });

    it("base '/preview/' prefixes every relativeUrl (trailing slash folded)", async () => {
      const entries = await buildCatalog([root], '/preview/');
      expect(entries[0]?.relativeUrl.startsWith('/preview/')).toBe(true);
      expect(entries[0]?.relativeUrl).not.toContain('/preview//');
      expect(entries[0]?.relativeUrl.endsWith('/mat.pack.json')).toBe(true);
    });

    it('custom base is applied verbatim', async () => {
      const entries = await buildCatalog([root], '/custom');
      expect(entries[0]?.relativeUrl.startsWith('/custom/')).toBe(true);
    });
  });

  // ─── refs pass-through (feat: listCatalog refs) ───

  describe('build-catalog-refs.test.ts', () => {
    let root: string;
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('carries .pack.json assets[].refs into the catalog row', async () => {
      root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-refs-'));
      const dep = '01890000-0000-7000-8000-bbbbbbbbbbbb';
      const pack = {
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        assets: [
          {
            guid: '01890000-0000-7000-8000-aaaaaaaaaaaa',
            kind: 'material',
            payload: {},
            refs: [dep],
          },
        ],
      };
      await writeFile(join(root, 'mat.pack.json'), JSON.stringify(pack), 'utf-8');
      const entries = await buildCatalog([root]);
      expect(entries.length).toBe(1);
      expect(entries[0]?.refs).toEqual([dep]);
    });

    it('omits refs when the pack row has an empty refs[]', async () => {
      root = await mkdtemp(join(tmpdir(), 'forgeax-vpp-refs-empty-'));
      const pack = {
        schemaVersion: '1.0.0',
        kind: 'internal-text-package',
        assets: [
          { guid: '01890000-0000-7000-8000-aaaaaaaaaaaa', kind: 'material', payload: {}, refs: [] },
        ],
      };
      await writeFile(join(root, 'mat.pack.json'), JSON.stringify(pack), 'utf-8');
      const entries = await buildCatalog([root]);
      // Empty refs[] still flows through as [] (present-but-empty), distinct
      // from a legacy row that never had a refs field.
      expect(entries[0]?.refs).toEqual([]);
    });
  });

  it('indexes the DejaVu font sampler declared by the bundled font package', async () => {
    const samplerGuid = '019eb276-4d96-7313-b4f0-f5d55536acd2';
    const result = await buildCatalogStrict([
      join(WORKTREE_ROOT, 'forgeax-engine-assets', 'dejavu-fonts'),
    ]);

    expect(result.errors).toEqual([]);
    expect(result.catalog.find((entry) => entry.guid === samplerGuid)).toMatchObject({
      kind: 'sampler',
      refs: [],
    });
  });
}

{
  // ─── from build-catalog-fail-fast.test.ts ───

  const WOOD_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';
  const ONE_BYTE_JPG = new Uint8Array([0xff]);

  describe('build-catalog-fail-fast.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-fail-fast-'));
      process.chdir(tmpRoot);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) sidecar without top-level importer -> error surfaced + 0 catalog rows', async () => {
      await writeFile(
        join(tmpRoot, 'wood-container.jpg.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          source: 'wood-container.jpg',
          importSettings: { colorSpace: 'srgb', mipmap: 'auto' },
          subAssets: [{ guid: WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
        }),
      );
      await writeFile(join(tmpRoot, 'wood-container.jpg'), ONE_BYTE_JPG);

      const result = await buildCatalogStrict([tmpRoot]);

      expect(result.catalog).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('(b) sidecar with an unregistered importer key -> raw-source row, no error (AC-08, w9)', async () => {
      // P2 (feat-20260629): the former whitelist wall rejected any importer
      // key outside the 5 engine built-ins with
      // `catalog-meta-unfoldable-importer`. After the wall is gone, an
      // unregistered key (here 'video', with an empty registered-key set)
      // keeps a raw-source row so the runtime can fall back to the source,
      // rather than failing the build.
      await writeFile(
        join(tmpRoot, 'wood-container.jpg.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'video',
          source: 'wood-container.jpg',
          importSettings: { colorSpace: 'srgb', mipmap: 'auto' },
          subAssets: [{ guid: WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
        }),
      );
      await writeFile(join(tmpRoot, 'wood-container.jpg'), ONE_BYTE_JPG);

      const result = await buildCatalogStrict([tmpRoot], '/', new Set());

      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(1);
      expect(result.catalog[0]?.guid.toLowerCase()).toBe(WOOD_GUID);
      expect(result.catalog[0]?.relativeUrl.endsWith('wood-container.jpg')).toBe(true);
    });

    it('(c) sidecar fails ajv schema (broken subAsset) -> error surfaced + 0 catalog rows', async () => {
      await writeFile(
        join(tmpRoot, 'wood-container.jpg.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: 'wood-container.jpg',
          importSettings: { colorSpace: 'srgb', mipmap: 'auto' },
          subAssets: [{ guid: 'not-a-uuid', sourceIndex: 0, kind: 'texture' }],
        }),
      );
      await writeFile(join(tmpRoot, 'wood-container.jpg'), ONE_BYTE_JPG);

      const result = await buildCatalogStrict([tmpRoot]);

      expect(result.catalog).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('(d) valid sidecar -> 0 errors + 1 catalog row', async () => {
      await writeFile(
        join(tmpRoot, 'wood-container.jpg.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: 'wood-container.jpg',
          importSettings: {
            colorSpace: 'srgb',
            mipmap: 'auto',
            addressMode: 'repeat',
            filterMode: 'linear',
          },
          subAssets: [{ guid: WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
        }),
      );
      await writeFile(join(tmpRoot, 'wood-container.jpg'), ONE_BYTE_JPG);

      const result = await buildCatalogStrict([tmpRoot]);

      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(1);
      expect(result.catalog[0]?.kind).toBe('texture');
    });
  });
}

{
  // ─── from build-catalog-font.test.ts ───

  const ATLAS_GUID = '019e2cc6-0c86-79da-aa76-b0984c86f001';
  const FONT_GUID = '019e2cc6-0c86-79da-aa76-b0984c86f002';
  const IMAGE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86f003';

  function fontMeta(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'font',
      source: 'Inter.atlas.png',
      importSettings: { colorSpace: 'linear', mipmap: 'none' },
      subAssets: [
        { guid: ATLAS_GUID, sourceIndex: 0, kind: 'texture' },
        { guid: FONT_GUID, sourceIndex: 1, kind: 'font' },
      ],
    });
  }

  function fontMetaNoSource(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'font',
      importSettings: {},
      subAssets: [{ guid: FONT_GUID, sourceIndex: 0, kind: 'font' }],
    });
  }

  function imageMeta(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'wood-container.jpg',
      importSettings: { colorSpace: 'srgb', mipmap: 'auto' },
      subAssets: [{ guid: IMAGE_GUID, sourceIndex: 0, kind: 'texture' }],
    });
  }

  const ONE_BYTE_FONT_FILE = new Uint8Array([0xff]);

  describe('build-catalog-font.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-font-'));
      process.chdir(tmpRoot);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) font sidecar produces an atlas texture row (metadata) + a font row (no metadata)', async () => {
      await writeFile(join(tmpRoot, 'Inter.atlas.png.meta.json'), fontMeta());
      await writeFile(join(tmpRoot, 'Inter.atlas.png'), ONE_BYTE_FONT_FILE);

      const result = await buildCatalogStrict([tmpRoot]);

      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(2);

      const texRows = result.catalog.filter((e) => e.kind === 'texture');
      expect(texRows).toHaveLength(1);
      const texRow = texRows[0];
      expect(texRow).toBeDefined();
      expect(texRow?.guid.toLowerCase()).toBe(ATLAS_GUID);
      expect(texRow?.metadata).toBeDefined();
      expect(texRow?.metadata?.kind).toBe('texture');

      const fontRows = result.catalog.filter((e) => e.kind === 'font');
      expect(fontRows).toHaveLength(1);
      const fontRow = fontRows[0];
      expect(fontRow).toBeDefined();
      expect(fontRow?.guid.toLowerCase()).toBe(FONT_GUID);
      expect(fontRow?.metadata).toBeUndefined();
    });

    it('(b) font / atlas rows carry the PackIndexEntry core fields', async () => {
      await writeFile(join(tmpRoot, 'Inter.atlas.png.meta.json'), fontMeta());
      await writeFile(join(tmpRoot, 'Inter.atlas.png'), ONE_BYTE_FONT_FILE);

      const result = await buildCatalogStrict([tmpRoot]);

      for (const row of result.catalog) {
        expect(row.relativeUrl.startsWith('/')).toBe(true);
        expect(row.relativeUrl.endsWith('Inter.atlas.png')).toBe(true);
        expect(row.sourcePath.endsWith('Inter.atlas.png')).toBe(true);
      }
      const fontRow = result.catalog.find((e) => e.kind === 'font');
      expect(fontRow?.guid.toLowerCase()).toBe(FONT_GUID);
    });

    it('(c) font sidecar without source field fails schema validation (no silent skip)', async () => {
      await writeFile(join(tmpRoot, 'Inter.atlas.png.meta.json'), fontMetaNoSource());

      const result = await buildCatalogStrict([tmpRoot]);

      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.catalog.filter((e) => e.kind === 'font')).toHaveLength(0);
    });

    it('(d) font arm is compatible with the existing image arm (no regression)', async () => {
      await writeFile(join(tmpRoot, 'Inter.atlas.png.meta.json'), fontMeta());
      await writeFile(join(tmpRoot, 'Inter.atlas.png'), ONE_BYTE_FONT_FILE);
      await writeFile(join(tmpRoot, 'wood.jpg.meta.json'), imageMeta());
      await writeFile(join(tmpRoot, 'wood-container.jpg'), ONE_BYTE_FONT_FILE);

      const result = await buildCatalogStrict([tmpRoot]);

      expect(result.errors).toHaveLength(0);
      expect(result.catalog.filter((e) => e.kind === 'texture')).toHaveLength(2);
      expect(result.catalog.filter((e) => e.kind === 'font')).toHaveLength(1);
    });

    // P1: font arm atlas sub.kind detection using 'texture' instead of 'image'.
    // After P1, the font sidecar declares the atlas subAsset with kind='texture'.
    it('(e) P1: font atlas subAsset with kind="texture" produces atlas texture row', async () => {
      const ATLAS_TEX_GUID = '019e2cc6-0c86-79da-aa76-b09840000f01';
      const FONT_TEX_GUID = '019e2cc6-0c86-79da-aa76-b09840000f02';
      const sidecar = JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'font',
        source: 'Inter.atlas.png',
        importSettings: { colorSpace: 'linear', mipmap: 'none' },
        subAssets: [
          { guid: ATLAS_TEX_GUID, sourceIndex: 0, kind: 'texture' },
          { guid: FONT_TEX_GUID, sourceIndex: 1, kind: 'font' },
        ],
      });
      await writeFile(join(tmpRoot, 'Inter.atlas.png.meta.json'), sidecar);
      await writeFile(join(tmpRoot, 'Inter.atlas.png'), ONE_BYTE_FONT_FILE);

      const result = await buildCatalogStrict([tmpRoot]);

      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(2);
      const texRows = result.catalog.filter((e) => e.kind === 'texture');
      expect(texRows).toHaveLength(1);
      expect(texRows[0]?.guid.toLowerCase()).toBe(ATLAS_TEX_GUID);
      expect(texRows[0]?.metadata).toBeDefined();
      expect(texRows[0]?.metadata?.kind).toBe('texture');

      const fontRows = result.catalog.filter((e) => e.kind === 'font');
      expect(fontRows).toHaveLength(1);
      expect(fontRows[0]?.guid.toLowerCase()).toBe(FONT_TEX_GUID);
    });
  });
}

{
  // ─── from build-catalog-gltf-arm.test.ts ───

  const SPONZA_META_PATH = join(
    WORKTREE_ROOT,
    'forgeax-engine-assets',
    'khronos-gltf-samples',
    'Sponza',
    'Sponza.gltf.meta.json',
  );

  const SYNTH_GLTF_GUID_MESH = '01900000-0000-7000-8000-bbbbbbbbbbbb';
  const SYNTH_GLTF_GUID_MATERIAL = '01900000-0000-7000-8000-cccccccccccc';
  const SYNTH_GLTF_SCENE_GUID = '01900000-0000-7000-8000-dddddddddddd';

  function syntheticGltfMeta(): string {
    return JSON.stringify({
      schemaVersion: 1,
      kind: 'external-asset-package',
      importer: 'gltf',
      source: 'synth.gltf',
      importSettings: { defaultSceneIndex: 0 },
      subAssets: [
        { guid: SYNTH_GLTF_GUID_MESH, sourceIndex: 0, kind: 'mesh' },
        { guid: SYNTH_GLTF_GUID_MATERIAL, sourceIndex: 0, kind: 'material' },
        { guid: SYNTH_GLTF_SCENE_GUID, sourceIndex: 0, kind: 'scene' },
      ],
    });
  }

  const GLTF_WOOD_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';

  function woodImageMetaGltf(mipmapToken: 'auto' | 'none'): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'wood-container.jpg',
      importSettings: {
        colorSpace: 'srgb',
        mipmap: mipmapToken,
        addressMode: 'repeat',
        filterMode: 'linear',
      },
      subAssets: [{ guid: GLTF_WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
    });
  }

  const ONE_BYTE_GLTF_FILE = new Uint8Array([0x00]);

  describe('build-catalog-gltf-arm.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-gltf-'));
      process.chdir(tmpRoot);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    async function setupSponzaFixture(dir: string): Promise<void> {
      await copyFile(SPONZA_META_PATH, join(dir, 'Sponza.gltf.meta.json'));
      await writeFile(join(dir, 'Sponza.gltf'), ONE_BYTE_GLTF_FILE);
    }

    it('(a) Sponza fixture sidecar -> 96 thin rows (1 mesh + 25 material + 1 scene + 69 texture)', async () => {
      await setupSponzaFixture(tmpRoot);

      const entries = await buildCatalog([tmpRoot]);

      const meshRows = entries.filter((e) => e.kind === 'mesh');
      const materialRows = entries.filter((e) => e.kind === 'material');
      const sceneRows = entries.filter((e) => e.kind === 'scene');
      const textureRows = entries.filter((e) => e.kind === 'texture');

      expect(meshRows).toHaveLength(1);
      expect(materialRows).toHaveLength(25);
      expect(sceneRows).toHaveLength(1);
      expect(textureRows).toHaveLength(69);
      expect(entries).toHaveLength(96);
    });

    it('(b) each row carries 4 core fields (guid / relativeUrl / kind / sourcePath); metadata undefined for mesh/material/scene, defined for texture', async () => {
      await setupSponzaFixture(tmpRoot);

      const entries = await buildCatalog([tmpRoot]);

      expect(entries.length).toBeGreaterThan(0);

      for (const row of entries) {
        expect(typeof row.guid).toBe('string');
        expect(row.guid.length).toBe(36);
        expect(typeof row.relativeUrl).toBe('string');
        expect(row.relativeUrl.startsWith('/')).toBe(true);
        expect(row.relativeUrl).not.toMatch(/\\/);
        expect(typeof row.kind).toBe('string');
        expect(['mesh', 'material', 'scene', 'texture']).toContain(row.kind);
        expect(typeof row.sourcePath).toBe('string');
        if (row.kind === 'mesh' || row.kind === 'material' || row.kind === 'scene') {
          expect(row.metadata).toBeUndefined();
        } else if (row.kind === 'texture') {
          expect(row.metadata).toBeDefined();
        }
      }
    });

    it('(c) kind values match sidecar subAssets[].kind literal (no remap)', async () => {
      await writeFile(join(tmpRoot, 'synth.gltf.meta.json'), syntheticGltfMeta());
      await writeFile(join(tmpRoot, 'synth.gltf'), ONE_BYTE_GLTF_FILE);

      const entries = await buildCatalog([tmpRoot]);

      const meshRow = entries.find((e) => e.guid.toLowerCase() === SYNTH_GLTF_GUID_MESH);
      const materialRow = entries.find((e) => e.guid.toLowerCase() === SYNTH_GLTF_GUID_MATERIAL);
      const sceneRow = entries.find((e) => e.guid.toLowerCase() === SYNTH_GLTF_SCENE_GUID);

      expect(meshRow?.kind).toBe('mesh');
      expect(materialRow?.kind).toBe('material');
      expect(sceneRow?.kind).toBe('scene');
    });

    it('(d) mixed sidecar dir (image + gltf) -> both arm rows present, no cross-interference', async () => {
      await writeFile(join(tmpRoot, 'wood-container.jpg.meta.json'), woodImageMetaGltf('auto'));
      await writeFile(join(tmpRoot, 'wood-container.jpg'), ONE_BYTE_GLTF_FILE);
      await writeFile(join(tmpRoot, 'synth.gltf.meta.json'), syntheticGltfMeta());
      await writeFile(join(tmpRoot, 'synth.gltf'), ONE_BYTE_GLTF_FILE);

      const entries = await buildCatalog([tmpRoot]);

      const textureRows = entries.filter((e) => e.kind === 'texture');
      expect(textureRows).toHaveLength(1);
      expect(textureRows[0]?.guid.toLowerCase()).toBe(GLTF_WOOD_GUID);
      expect(textureRows[0]?.metadata).toBeDefined();

      const meshRows = entries.filter((e) => e.kind === 'mesh');
      const materialRows = entries.filter((e) => e.kind === 'material');
      const sceneRows = entries.filter((e) => e.kind === 'scene');

      expect(meshRows).toHaveLength(1);
      expect(meshRows[0]?.guid.toLowerCase()).toBe(SYNTH_GLTF_GUID_MESH);
      expect(meshRows[0]?.metadata).toBeUndefined();

      expect(materialRows).toHaveLength(1);
      expect(materialRows[0]?.guid.toLowerCase()).toBe(SYNTH_GLTF_GUID_MATERIAL);
      expect(materialRows[0]?.metadata).toBeUndefined();

      expect(sceneRows).toHaveLength(1);
      expect(sceneRows[0]?.guid.toLowerCase()).toBe(SYNTH_GLTF_SCENE_GUID);
      expect(sceneRows[0]?.metadata).toBeUndefined();

      expect(entries).toHaveLength(4);
    });
  });
}

{
  // ─── from build-catalog-gltf-texture.test.ts ───

  const TEXTURE_GUID_1 = '01900000-0000-7000-8000-aaaaaaaaaaaa';
  const TEXTURE_GUID_2 = '01900000-0000-7000-8000-eeeeeeeeeeee';
  const MESH_GUID = '01900000-0000-7000-8000-bbbbbbbbbbbb';
  const SCENE_GUID = '01900000-0000-7000-8000-dddddddddddd';

  function gltfMetaWithTextures(): string {
    return JSON.stringify({
      schemaVersion: 1,
      kind: 'external-asset-package',
      importer: 'gltf',
      source: 'textured.gltf',
      importSettings: {
        defaultSceneIndex: 0,
      },
      subAssets: [
        { guid: MESH_GUID, sourceIndex: 0, kind: 'mesh' },
        { guid: TEXTURE_GUID_1, sourceIndex: 0, kind: 'texture', name: 'baseColor' },
        { guid: TEXTURE_GUID_2, sourceIndex: 1, kind: 'texture', name: 'normal' },
        { guid: SCENE_GUID, sourceIndex: 0, kind: 'scene' },
      ],
    });
  }

  const ONE_BYTE_GTEX_FILE = new Uint8Array([0x00]);

  describe('build-catalog-gltf-texture.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-gltf-tex-'));
      process.chdir(tmpRoot);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) texture sub-assets produce 5-field rows with metadata', async () => {
      await writeFile(join(tmpRoot, 'textured.gltf.meta.json'), gltfMetaWithTextures());
      await writeFile(join(tmpRoot, 'textured.gltf'), ONE_BYTE_GTEX_FILE);

      const entries = await buildCatalog([tmpRoot]);

      const textureRows = entries.filter((e) => e.kind === 'texture');
      expect(textureRows).toHaveLength(2);

      for (const row of textureRows) {
        expect(typeof row.guid).toBe('string');
        expect(row.guid.length).toBe(36);
        expect(typeof row.relativeUrl).toBe('string');
        expect(row.relativeUrl.startsWith('/')).toBe(true);
        expect(typeof row.sourcePath).toBe('string');
        expect(row.metadata).toBeDefined();
        if (row.metadata === undefined) continue;
        expect(row.metadata.kind).toBe('texture');
        expect(typeof row.metadata.format).toBe('string');
        expect(['srgb', 'linear']).toContain(row.metadata.colorSpace);
        expect(typeof row.metadata.colorSpace).toBe('string');
      }

      const meshRows = entries.filter((e) => e.kind === 'mesh');
      const sceneRows = entries.filter((e) => e.kind === 'scene');
      expect(meshRows).toHaveLength(1);
      expect(meshRows[0]?.metadata).toBeUndefined();
      expect(sceneRows).toHaveLength(1);
      expect(sceneRows[0]?.metadata).toBeUndefined();
    });

    it('(b) texture rows coexist with mesh/material/scene rows (no cross-interference)', async () => {
      await writeFile(join(tmpRoot, 'textured.gltf.meta.json'), gltfMetaWithTextures());
      await writeFile(join(tmpRoot, 'textured.gltf'), ONE_BYTE_GTEX_FILE);

      const entries = await buildCatalog([tmpRoot]);

      expect(entries.filter((e) => e.kind === 'texture')).toHaveLength(2);
      expect(entries.filter((e) => e.kind === 'mesh')).toHaveLength(1);
      expect(entries.filter((e) => e.kind === 'scene')).toHaveLength(1);
      expect(entries).toHaveLength(4);
    });

    it('(c) metadata shape matches ImageMetadata (kind/texture, format, colorSpace, mipmap)', async () => {
      await writeFile(join(tmpRoot, 'textured.gltf.meta.json'), gltfMetaWithTextures());
      await writeFile(join(tmpRoot, 'textured.gltf'), ONE_BYTE_GTEX_FILE);

      const entries = await buildCatalog([tmpRoot]);

      const texRow = entries.find(
        (e) => e.guid.toLowerCase() === TEXTURE_GUID_1 && e.kind === 'texture',
      );
      expect(texRow).toBeDefined();
      if (texRow === undefined) return;

      expect(texRow.metadata).toBeDefined();
      if (texRow.metadata === undefined || texRow.metadata.kind !== 'texture') return;

      expect(texRow.metadata.kind).toBe('texture');
      expect(texRow.metadata.format).toMatch(/^rgba/);
      expect(['srgb', 'linear']).toContain(texRow.metadata.colorSpace);
      expect(typeof texRow.metadata.mipmap).toBe('boolean');
    });
  });
}

{
  // ─── from build-catalog-hdr-equirect.test.ts ───

  const HDR_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45d';

  function hdrEquirectMeta(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'newport_loft.hdr',
      importSettings: {
        colorSpace: 'linear',
        mipmap: 'none',
      },
      subAssets: [
        {
          guid: HDR_GUID,
          sourceIndex: 0,
          kind: 'equirect',
        },
      ],
    });
  }

  const ONE_BYTE_HDR_FILE = new Uint8Array([0x01]);

  describe('build-catalog-hdr-equirect.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w7-'));
      process.chdir(tmpRoot);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) .hdr equirect subAsset -> kind:"equirect" + ImageMetadata(rgba16float)', async () => {
      await writeFile(join(tmpRoot, 'newport_loft.hdr.meta.json'), hdrEquirectMeta());
      await writeFile(join(tmpRoot, 'newport_loft.hdr'), ONE_BYTE_HDR_FILE);

      const entries = await buildCatalog([tmpRoot]);
      const hdrRows = entries.filter((e) => e.guid.toLowerCase() === HDR_GUID);

      expect(hdrRows).toHaveLength(1);
      const row = hdrRows[0];
      expect(row).toBeDefined();
      if (!row) return;

      expect(row.kind).toBe('equirect');

      const meta = row.metadata;
      expect(meta).toBeDefined();
      if (meta === undefined || meta.kind !== 'texture') return;

      expect(meta.format).toBe('rgba16float');
      expect(meta.colorSpace).toBe('linear');
      expect(meta.mipmap).toBe(false);
    });

    // Regression for the runtime "sky.hdr equirect->cubemap upload failed:
    // invalid-source-format" the templates/game-default game emits at start.
    // The submodule sidecar at forgeax-engine-assets/demo-assets/
    // template-game-default/sky.hdr.meta.json must declare its single
    // subAsset as `kind:'equirect'` so the build catalog routes the .hdr to
    // the rgba16float / linear arm — anything else lands in
    // `colorSpaceToFormat('linear')` -> `'rgba8unorm'`, which the runtime
    // equirect projection rejects. The fixture is the literal sidecar checked
    // into the assets submodule (migrated to kind:'equirect' in w9), so this
    // catches drift the moment a future sidecar edit re-introduces the mistake.
    it('(c) [regression] template-game-default sky.hdr sidecar produces rgba16float equirect row', async () => {
      const fixtureDir = join(
        WORKTREE_ROOT,
        'forgeax-engine-assets',
        'demo-assets',
        'template-game-default',
      );

      const entries = await buildCatalog([fixtureDir]);
      const skyRows = entries.filter(
        (e) => e.guid.toLowerCase() === '81eec382-392f-5a93-8998-0ecf11ef7990',
      );

      expect(skyRows).toHaveLength(1);
      const row = skyRows[0];
      if (!row) return;
      // The HDR must land as `kind:'equirect'` + rgba16float, the format the
      // runtime store consumes for the cube-to-cube IBL projection.
      expect(row.kind).toBe('equirect');
      const meta = row.metadata;
      if (meta === undefined || meta.kind !== 'texture') {
        throw new Error('sky.hdr sidecar produced no equirect metadata');
      }
      expect(meta.format).toBe('rgba16float');
      expect(meta.colorSpace).toBe('linear');
    });
  });
}

{
  // ─── from build-catalog-image-arm.test.ts ───

  const IMG_WOOD_GUID = '019e2cc6-0c86-79da-aa76-b0984c86d45c';

  function woodImageMetaImg(mipmapToken: 'auto' | 'none'): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'wood-container.jpg',
      importSettings: {
        colorSpace: 'srgb',
        mipmap: mipmapToken,
        addressMode: 'repeat',
        filterMode: 'linear',
      },
      subAssets: [
        {
          guid: IMG_WOOD_GUID,
          sourceIndex: 0,
          kind: 'texture',
        },
      ],
    });
  }

  const IMG_ONE_BYTE_JPG = new Uint8Array([0xff]);

  const PACK_JSON_FIXTURE = JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'internal-text-package',
    assets: [
      {
        guid: '01890000-0000-7000-8000-aaaaaaaaaaaa',
        kind: 'mesh',
        payload: {},
        refs: [],
      },
    ],
  });

  describe('build-catalog-image-arm.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w2-'));
      process.chdir(tmpRoot);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) wood-container.jpg.meta.json + .jpg -> kind: "texture" + metadata 5-field', async () => {
      await writeFile(join(tmpRoot, 'wood-container.jpg.meta.json'), woodImageMetaImg('auto'));
      await writeFile(join(tmpRoot, 'wood-container.jpg'), IMG_ONE_BYTE_JPG);

      const entries = await buildCatalog([tmpRoot]);
      const textureRows = entries.filter((e) => e.kind === 'texture');

      expect(textureRows).toHaveLength(1);
      const row = textureRows[0];
      expect(row).toBeDefined();
      if (row === undefined) return;
      expect(row.guid.toLowerCase()).toBe(IMG_WOOD_GUID);
      expect(row.relativeUrl.endsWith('wood-container.jpg')).toBe(true);
      expect(row.relativeUrl.startsWith('/')).toBe(true);
      expect(row.relativeUrl).not.toMatch(/\\/);
      expect(row.sourcePath.endsWith('wood-container.jpg')).toBe(true);
      expect(row.metadata).toBeDefined();
      const meta = row.metadata;
      if (meta === undefined || meta.kind !== 'texture') return;
      expect(meta.colorSpace).toBe('srgb');
      expect(meta.mipmap).toBe(true);
      expect(meta.format).toBe('rgba8unorm-srgb');
    });

    it('(b) legacy .pack.json still produces existing kind/guid rows (no regression)', async () => {
      await writeFile(join(tmpRoot, 'legacy.pack.json'), PACK_JSON_FIXTURE);

      const entries = await buildCatalog([tmpRoot]);
      const meshRows = entries.filter((e) => e.kind === 'mesh');

      expect(meshRows).toHaveLength(1);
      expect(meshRows[0]?.guid.toLowerCase()).toBe('01890000-0000-7000-8000-aaaaaaaaaaaa');
      expect(meshRows[0]?.relativeUrl.endsWith('legacy.pack.json')).toBe(true);
      expect(meshRows[0]?.relativeUrl.startsWith('/')).toBe(true);
      expect(meshRows[0]?.relativeUrl).not.toMatch(/\\/);
      expect(meshRows[0]?.metadata).toBeUndefined();
    });

    it('(c) JPG present without sidecar -> no catalog entry (R-06 boundary)', async () => {
      await writeFile(join(tmpRoot, 'orphan.jpg'), IMG_ONE_BYTE_JPG);

      const entries = await buildCatalog([tmpRoot]);

      expect(entries).toHaveLength(0);
    });

    it('(d) sidecar mipmap: "none" -> metadata.mipmap === false (D-5 mapping)', async () => {
      await writeFile(join(tmpRoot, 'wood-container.jpg.meta.json'), woodImageMetaImg('none'));
      await writeFile(join(tmpRoot, 'wood-container.jpg'), IMG_ONE_BYTE_JPG);

      const entries = await buildCatalog([tmpRoot]);
      const textureRows = entries.filter((e) => e.kind === 'texture');

      expect(textureRows).toHaveLength(1);
      const dMeta = textureRows[0]?.metadata;
      if (dMeta === undefined || dMeta.kind !== 'texture') return;
      expect(dMeta.mipmap).toBe(false);
    });

    // P1: image arm sub.kind passthrough — after P1, sub.kind in the sidecar is
    // 'texture' (not 'image'), and buildCatalog passes it through directly
    // without the former hard-coded 'image'→'texture' remap.
    it('(e) P1: sub.kind="texture" in meta.json sidecar → passthrough without hard-coded remap', async () => {
      const IMG_K_TEXTURE_GUID = '019e2cca-0c86-79da-aa76-b09840000e01';
      const sidecar = JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'image',
        source: 'passthrough.jpg',
        importSettings: { colorSpace: 'srgb', mipmap: 'auto' },
        subAssets: [{ guid: IMG_K_TEXTURE_GUID, sourceIndex: 0, kind: 'texture' }],
      });
      await writeFile(join(tmpRoot, 'passthrough.jpg.meta.json'), sidecar);
      await writeFile(join(tmpRoot, 'passthrough.jpg'), IMG_ONE_BYTE_JPG);

      const entries = await buildCatalog([tmpRoot]);
      const textureRows = entries.filter((e) => e.kind === 'texture');

      expect(textureRows).toHaveLength(1);
      const row = textureRows[0];
      expect(row).toBeDefined();
      if (row === undefined) return;
      expect(row.guid.toLowerCase()).toBe(IMG_K_TEXTURE_GUID);
      expect(row.metadata).toBeDefined();
      const meta = row.metadata;
      if (meta === undefined || meta.kind !== 'texture') return;
      expect(meta.colorSpace).toBe('srgb');
    });
  });
}

{
  // ─── from build-import-hdr.test.ts ───

  const IMP_HDR_GUID = '019e3969-1d43-7610-8810-e80dbd491d91';
  const IMP_WOOD_GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';
  const FIXTURE_PNG_SRC = join(
    WORKTREE_ROOT,
    'forgeax-engine-assets',
    'learn-opengl',
    'textures',
    'wood.png',
  );

  function woodImageMetaImport(): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: 'wood.png',
      importSettings: {
        colorSpace: 'srgb',
        mipmap: 'auto',
        addressMode: 'repeat',
        filterMode: 'linear',
      },
      subAssets: [{ guid: IMP_WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
    });
  }

  function makeMinimalHdr(width: number, height: number): Uint8Array {
    const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${height} +X ${width}\n`;
    const encoder = new TextEncoder();
    const headerBytes = encoder.encode(header);

    const hi = (width >> 8) & 0xff;
    const lo = width & 0xff;
    const prefix = new Uint8Array([0x02, 0x02, hi, lo]);
    const chRun = new Uint8Array([128 + width, 128]);
    const scanlineBytes = 4 + 4 * 2;
    const pixelBytes = new Uint8Array(height * scanlineBytes);

    for (let y = 0; y < height; y++) {
      let off = y * scanlineBytes;
      pixelBytes.set(prefix, off);
      off += 4;
      pixelBytes.set(chRun, off);
      off += 2;
      pixelBytes.set(chRun, off);
      off += 2;
      pixelBytes.set(chRun, off);
      off += 2;
      pixelBytes.set(chRun, off);
    }

    const total = new Uint8Array(headerBytes.length + pixelBytes.length);
    total.set(headerBytes);
    total.set(pixelBytes, headerBytes.length);
    return total;
  }

  function impHdrEquirectMeta(hdrFilename: string): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source: hdrFilename,
      importSettings: {
        colorSpace: 'linear',
        mipmap: 'none',
      },
      subAssets: [
        {
          guid: IMP_HDR_GUID,
          sourceIndex: 0,
          kind: 'equirect',
        },
      ],
    });
  }

  const MAIN_JS = `// minimal entry; pack plugin emits assets independently
console.log('import-hdr-test entry');
`;

  describe('build-import-hdr.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;
    let assetsDir: string;
    let distDir: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w9-'));
      assetsDir = join(tmpRoot, 'assets');
      distDir = join(tmpRoot, 'dist');
      process.chdir(tmpRoot);

      const hdrData = makeMinimalHdr(8, 4);
      await writeFile(join(tmpRoot, 'main.js'), MAIN_JS);
      await mkdir(assetsDir, { recursive: true });
      await writeFile(join(assetsDir, 'env.hdr'), hdrData);
      await writeFile(join(assetsDir, 'env.hdr.meta.json'), impHdrEquirectMeta('env.hdr'));
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    async function readPackIndex(): Promise<PackIndexEntry[]> {
      const raw = await readFile(join(distDir, 'pack-index.json'), 'utf-8');
      return JSON.parse(raw) as PackIndexEntry[];
    }

    async function findBinFiles(): Promise<string[]> {
      const distAssetsDir = join(distDir, 'assets');
      try {
        const { readdir: rd } = await import('node:fs/promises');
        const names = await rd(distAssetsDir);
        return names.filter((n) => n.endsWith('.bin'));
      } catch {
        return [];
      }
    }

    async function findAllDistAssets(): Promise<string[]> {
      const distAssetsDir = join(distDir, 'assets');
      try {
        const { readdir: rd } = await import('node:fs/promises');
        return await rd(distAssetsDir);
      } catch {
        return [];
      }
    }

    const HDR_WIDTH = 8;
    const HDR_HEIGHT = 4;

    it('(a) w10: import step recognizes .hdr -> relativeUrl ends with .bin (not .hdr)', async () => {
      await viteBuild({
        root: tmpRoot,
        logLevel: 'silent',
        configFile: false,
        build: {
          outDir: distDir,
          emptyOutDir: true,
          write: true,
          rollupOptions: {
            input: { main: 'main.js' },
          },
        },
        plugins: [pluginPack({ roots: [assetsDir] })],
      });

      const entries = await readPackIndex();
      const hdrRow = entries.find((e) => e.guid.toLowerCase() === IMP_HDR_GUID);
      expect(hdrRow).toBeDefined();
      expect(hdrRow?.kind).toBe('equirect');

      const relUrl = hdrRow?.relativeUrl ?? '';
      expect(relUrl.endsWith('.bin')).toBe(true);
      expect(relUrl.toLowerCase()).toContain(IMP_HDR_GUID);
      expect(relUrl.toLowerCase()).not.toContain('.hdr');
    });

    it('(b) w10: a .bin with the HDR guid prefix is emitted in dist/assets/', async () => {
      await viteBuild({
        root: tmpRoot,
        logLevel: 'silent',
        configFile: false,
        build: {
          outDir: distDir,
          emptyOutDir: true,
          write: true,
          rollupOptions: {
            input: { main: 'main.js' },
          },
        },
        plugins: [pluginPack({ roots: [assetsDir] })],
      });

      const binFiles = await findBinFiles();
      const hdrBin = binFiles.find((f) => f.toLowerCase().includes(IMP_HDR_GUID));
      expect(hdrBin).toBeDefined();
      expect(hdrBin?.endsWith('.bin')).toBe(true);
    });

    it('(c) w10: metadata.format is rgba16float after import', async () => {
      await viteBuild({
        root: tmpRoot,
        logLevel: 'silent',
        configFile: false,
        build: {
          outDir: distDir,
          emptyOutDir: true,
          write: true,
          rollupOptions: {
            input: { main: 'main.js' },
          },
        },
        plugins: [pluginPack({ roots: [assetsDir] })],
      });

      const entries = await readPackIndex();
      const hdrRow = entries.find((e) => e.guid.toLowerCase() === IMP_HDR_GUID);
      expect(hdrRow).toBeDefined();
      const meta = hdrRow?.metadata;
      expect(meta).toBeDefined();
      if (meta === undefined || meta.kind !== 'texture') return;
      expect(meta.format).toBe('rgba16float');
      expect(meta.colorSpace).toBe('linear');
    });

    it("(d) feat-20260707 fix: default 'auto' HDR equirect stays uncompressed rgba16float .bin", async () => {
      await viteBuild({
        root: tmpRoot,
        logLevel: 'silent',
        configFile: false,
        build: {
          outDir: distDir,
          emptyOutDir: true,
          write: true,
          rollupOptions: {
            input: { main: 'main.js' },
          },
        },
        plugins: [pluginPack({ roots: [assetsDir] })],
      });

      const binFiles = await findBinFiles();
      const hdrBin = binFiles.find((f) => f.toLowerCase().includes(IMP_HDR_GUID));
      expect(hdrBin).toBeDefined();
      if (hdrBin === undefined) return;

      // The sidecar declares no compressionMode -> default 'auto'. An equirect is
      // ALWAYS an IBL / skybox source (equirect-to-cube / irradiance / prefilter
      // RENDER passes) and BC6H is not color-renderable, so the equirect kind is
      // never block-compressed: the emitted `.bin` carries raw rgba16float (NOT a
      // Basis KTX2) and the pack-index row records compression 'none'.
      const raw = await readFile(join(distDir, 'assets', hdrBin));
      const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
      expect(Array.from(raw.subarray(0, 12))).not.toEqual(KTX2_MAGIC);
      expect(raw.byteLength).toBe(HDR_WIDTH * HDR_HEIGHT * 4 * 2);

      const entries = await readPackIndex();
      const hdrRow = entries.find((e) => e.guid.toLowerCase() === IMP_HDR_GUID);
      expect(hdrRow?.compression).toBe('none');
    });

    it('(e) w11: metadata width/height match the imported (decoded HDR) values', async () => {
      await viteBuild({
        root: tmpRoot,
        logLevel: 'silent',
        configFile: false,
        build: {
          outDir: distDir,
          emptyOutDir: true,
          write: true,
          rollupOptions: {
            input: { main: 'main.js' },
          },
        },
        plugins: [pluginPack({ roots: [assetsDir] })],
      });

      const entries = await readPackIndex();
      const hdrRow = entries.find((e) => e.guid.toLowerCase() === IMP_HDR_GUID);
      expect(hdrRow).toBeDefined();
      const meta = hdrRow?.metadata;
      expect(meta).toBeDefined();
      if (meta === undefined || meta.kind !== 'texture') return;
      expect(meta.width).toBe(HDR_WIDTH);
      expect(meta.height).toBe(HDR_HEIGHT);
    });

    it('(f) w6: post-extraction, a normal PNG row still imports -> .bin + folded width/height', async () => {
      const png = await readFile(FIXTURE_PNG_SRC);
      await writeFile(join(assetsDir, 'wood.png'), png);
      await writeFile(join(assetsDir, 'wood.png.meta.json'), woodImageMetaImport());

      await viteBuild({
        root: tmpRoot,
        logLevel: 'silent',
        configFile: false,
        build: {
          outDir: distDir,
          emptyOutDir: true,
          write: true,
          rollupOptions: { input: { main: 'main.js' } },
        },
        plugins: [pluginPack({ roots: [assetsDir] })],
      });

      const entries = await readPackIndex();
      const pngRow = entries.find((e) => e.guid.toLowerCase() === IMP_WOOD_GUID);
      expect(pngRow).toBeDefined();
      expect(pngRow?.kind).toBe('texture');
      expect(pngRow?.relativeUrl.endsWith('.bin')).toBe(true);
      expect(pngRow?.relativeUrl.toLowerCase()).not.toContain('.png');
      const meta = pngRow?.metadata;
      expect(meta).toBeDefined();
      if (meta === undefined || meta.kind !== 'texture') return;
      expect(meta.width).toBeGreaterThan(0);
      expect(meta.height).toBeGreaterThan(0);
      expect(meta.format).toBe('rgba8unorm-srgb');

      const hdrRow = entries.find((e) => e.guid.toLowerCase() === IMP_HDR_GUID);
      expect(hdrRow?.relativeUrl.endsWith('.bin')).toBe(true);
    });

    it('(g) build pre-import for the HDR equirect meta emits a .bin (not a .pack.json)', async () => {
      await viteBuild({
        root: tmpRoot,
        logLevel: 'silent',
        configFile: false,
        build: {
          outDir: distDir,
          emptyOutDir: true,
          write: true,
          rollupOptions: { input: { main: 'main.js' } },
        },
        plugins: [pluginPack({ roots: [assetsDir] })],
      });

      const entries = await readPackIndex();
      const hdrRow = entries.find((e) => e.guid.toLowerCase() === IMP_HDR_GUID);
      expect(hdrRow).toBeDefined();
      expect(hdrRow?.relativeUrl.endsWith('.bin')).toBe(true);
      expect(hdrRow?.relativeUrl.toLowerCase()).not.toContain('.pack.json');
      const meta = hdrRow?.metadata;
      expect(meta).toBeDefined();
      if (meta === undefined || meta.kind !== 'texture') return;
      expect(meta.format).toBe('rgba16float');
      expect(meta.width).toBe(HDR_WIDTH);
      expect(meta.height).toBe(HDR_HEIGHT);
      const distAssets = await findAllDistAssets();
      const packJsonForHdr = distAssets.filter(
        (n) => n.toLowerCase().includes(IMP_HDR_GUID) && n.endsWith('.pack.json'),
      );
      expect(packJsonForHdr).toEqual([]);
    });
  });
}

{
  // ─── from plugin-build.test.ts (test/ -> src/__tests__/) ───

  // Compile pack-index schema validator
  const ajv = new Ajv({ strict: false, allErrors: false });
  addFormats(ajv, ['uuid']);
  const validatePackIndex = ajv.compile(packIndexSchemaJson);

  interface EmitFileArg {
    type: string;
    fileName: string;
    source: string;
  }

  interface MinimalPluginContext {
    emitFile: (arg: EmitFileArg) => string;
  }

  interface PluginLike {
    name: string;
    generateBundle?: (this: MinimalPluginContext) => void | Promise<void>;
    configureServer?: (server: unknown) => void;
  }

  describe('plugin-build.test.ts', () => {
    it('generateBundle emits a file named pack-index.json', async () => {
      const plugin = pluginPack({ roots: [] }) as PluginLike;
      if (plugin.generateBundle === undefined) {
        expect.fail('pluginPack does not have generateBundle hook');
      }

      const emittedFiles: EmitFileArg[] = [];
      const ctx: MinimalPluginContext = {
        emitFile(arg: EmitFileArg): string {
          emittedFiles.push(arg);
          return arg.fileName;
        },
      };

      await plugin.generateBundle.call(ctx);

      const packIndexFile = emittedFiles.find((f) => f.fileName === 'pack-index.json');
      expect(packIndexFile).toBeDefined();
      expect(packIndexFile?.type).toBe('asset');
    });

    it('emitted pack-index.json content is valid JSON array', async () => {
      const plugin = pluginPack({ roots: [] }) as PluginLike;
      if (plugin.generateBundle === undefined) {
        expect.fail('pluginPack does not have generateBundle hook');
      }

      const emittedFiles: EmitFileArg[] = [];
      const ctx: MinimalPluginContext = {
        emitFile(arg: EmitFileArg): string {
          emittedFiles.push(arg);
          return arg.fileName;
        },
      };

      await plugin.generateBundle.call(ctx);

      const packIndexFile = emittedFiles.find((f) => f.fileName === 'pack-index.json');
      expect(packIndexFile).toBeDefined();
      if (!packIndexFile) return;

      const parsed = JSON.parse(packIndexFile.source) as unknown;
      expect(Array.isArray(parsed)).toBe(true);
    });

    it('emitted pack-index.json content is valid per pack-index.schema.json', async () => {
      const plugin = pluginPack({ roots: [] }) as PluginLike;
      if (plugin.generateBundle === undefined) {
        expect.fail('pluginPack does not have generateBundle hook');
      }

      const emittedFiles: EmitFileArg[] = [];
      const ctx: MinimalPluginContext = {
        emitFile(arg: EmitFileArg): string {
          emittedFiles.push(arg);
          return arg.fileName;
        },
      };

      await plugin.generateBundle.call(ctx);

      const packIndexFile = emittedFiles.find((f) => f.fileName === 'pack-index.json');
      expect(packIndexFile).toBeDefined();
      if (!packIndexFile) return;

      const parsed = JSON.parse(packIndexFile.source) as unknown;
      const valid = validatePackIndex(parsed);
      expect(valid).toBe(true);
      if (!valid) {
        console.error('pack-index schema errors:', validatePackIndex.errors);
      }
    });
  });
}

{
  // --- from build-catalog-name.test.ts (w23 AC-11) ---

  describe('AC-11 PackIndexEntry.name same-source (w23)', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w23-'));
      process.chdir(tmpRoot);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('single-asset .pack.json → name === basename(packagePath) per deriveAssetName', async () => {
      const packPath = join(tmpRoot, 'hero.pack.json');
      await writeFile(
        packPath,
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'internal-text-package',
          assets: [
            { guid: '01900000-0000-7000-8000-00000000000a', kind: 'mesh', payload: {}, refs: [] },
          ],
        }),
      );

      const entries = await buildCatalog([tmpRoot]);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry).toBeDefined();
      if (!entry) return;
      expect(entry.name).toBe(deriveAssetName(packPath, 1));
      expect(entry.name).toBe('hero.pack.json');
    });

    it('multi-asset .pack.json with name → name === storedName', async () => {
      const packPath = join(tmpRoot, 'multi.pack.json');
      await writeFile(
        packPath,
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'internal-text-package',
          assets: [
            {
              guid: '01900000-0000-7000-8000-00000000000b',
              kind: 'mesh',
              payload: {},
              refs: [],
              name: 'Body',
            },
            {
              guid: '01900000-0000-7000-8000-00000000000c',
              kind: 'material',
              payload: {},
              refs: [],
              name: 'Skin',
            },
          ],
        }),
      );

      const entries = await buildCatalog([tmpRoot]);
      expect(entries).toHaveLength(2);
      const names = entries.map((e) => e.name);
      expect(names).toEqual([
        deriveAssetName(packPath, 2, 'Body'),
        deriveAssetName(packPath, 2, 'Skin'),
      ]);
      expect(names).toEqual(['Body', 'Skin']);
    });

    it('multi-asset .pack.json without name → name === basename(packPath) (AC-15 fallback)', async () => {
      const packPath = join(tmpRoot, 'multi.pack.json');
      await writeFile(
        packPath,
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'internal-text-package',
          assets: [
            { guid: '01900000-0000-7000-8000-00000000000d', kind: 'mesh', payload: {}, refs: [] },
            {
              guid: '01900000-0000-7000-8000-00000000000e',
              kind: 'material',
              payload: {},
              refs: [],
            },
          ],
        }),
      );

      const entries = await buildCatalog([tmpRoot]);
      expect(entries).toHaveLength(2);
      for (const entry of entries) {
        expect(entry.name).toBe(deriveAssetName(packPath, 2));
        expect(entry.name).toBe('multi.pack.json');
      }
    });

    it('meta.json gltf arm multi-asset → name per subAssets[].name via deriveAssetName', async () => {
      const sourcePath = join(tmpRoot, 'soldier.gltf');
      await writeFile(sourcePath, new Uint8Array([0x00]));
      const sp = sourcePath;

      await writeFile(
        join(tmpRoot, 'soldier.gltf.meta.json'),
        JSON.stringify({
          schemaVersion: 1,
          kind: 'external-asset-package',
          importer: 'gltf',
          source: 'soldier.gltf',
          importSettings: { defaultSceneIndex: 0 },
          subAssets: [
            {
              guid: '01900000-0000-7000-8000-00000000000f',
              sourceIndex: 0,
              kind: 'mesh',
              name: 'Soldier_Body',
            },
            {
              guid: '01900000-0000-7000-8000-000000000010',
              sourceIndex: 1,
              kind: 'mesh',
              name: 'Soldier_Head',
            },
            { guid: '01900000-0000-7000-8000-000000000011', sourceIndex: 0, kind: 'scene' },
          ],
        }),
      );

      const entries = await buildCatalog([tmpRoot]);
      expect(entries).toHaveLength(3);

      const meshRows = entries.filter((e) => e.kind === 'mesh');
      expect(meshRows).toHaveLength(2);
      expect(meshRows[0]?.name).toBe(deriveAssetName(sp, 3, 'Soldier_Body'));
      expect(meshRows[0]?.name).toBe('Soldier_Body');
      expect(meshRows[1]?.name).toBe(deriveAssetName(sp, 3, 'Soldier_Head'));
      expect(meshRows[1]?.name).toBe('Soldier_Head');

      const sceneRows = entries.filter((e) => e.kind === 'scene');
      expect(sceneRows).toHaveLength(1);
      expect(sceneRows[0]?.name).toBe(deriveAssetName(sp, 3));
      expect(sceneRows[0]?.name).toBe('soldier.gltf');
    });

    it('meta.json image arm single-asset → name === basename(sourcePath)', async () => {
      const sourcePath = join(tmpRoot, 'hero.jpg');
      await writeFile(sourcePath, new Uint8Array([0xff]));

      await writeFile(
        join(tmpRoot, 'hero.jpg.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: 'hero.jpg',
          importSettings: {
            colorSpace: 'srgb',
            mipmap: 'auto',
            addressMode: 'repeat',
            filterMode: 'linear',
          },
          subAssets: [
            { guid: '019e2cc6-0c86-79da-aa76-000000000000', sourceIndex: 0, kind: 'texture' },
          ],
        }),
      );

      const entries = await buildCatalog([tmpRoot]);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry).toBeDefined();
      if (!entry) return;
      expect(entry.kind).toBe('texture');
      expect(entry.name).toBe(deriveAssetName(sourcePath, 1));
      expect(entry.name).toBe('hero.jpg');
    });
  });

  // ─── cross-root GUID collision degradation (downstream template integration #3) ───
  //
  // scan(roots) is fail-fast: a single duplicate GUID anywhere across all
  // roots returns Err(pack-guid-collision). buildCatalog must NOT collapse the
  // whole catalog to [] on that error -- two independently-authored games may
  // legitimately reuse a GUID, and one game's collision must not blank every
  // other game's assets on a shared dev server. It degrades to per-root scans,
  // dedups by GUID across roots (keep first), and drops only the offending root.

  const GUID_A = '01890000-0000-7000-8000-aaaaaaaaaaaa';
  const GUID_B = '01890000-0000-7000-8000-bbbbbbbbbbbb';
  const GUID_SHARED = '01890000-0000-7000-8000-cccccccccccc';

  async function makeGameRoot(prefix: string, guids: string[]): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), `forgeax-vpp-${prefix}-`));
    const pack = {
      schemaVersion: '1.0.0',
      kind: 'internal-text-package',
      assets: guids.map((guid) => ({ guid, kind: 'material', payload: {}, refs: [] })),
    };
    await writeFile(join(root, `${prefix}.pack.json`), JSON.stringify(pack), 'utf-8');
    return root;
  }

  describe('build-catalog-cross-root-collision.test.ts', () => {
    const roots: string[] = [];
    afterEach(async () => {
      await Promise.all(roots.map((r) => rm(r, { recursive: true, force: true })));
      roots.length = 0;
    });

    it('cross-root GUID collision degrades per-root instead of collapsing the whole catalog', async () => {
      // gameA + gameB each declare the same shared GUID (legitimate cross-game
      // reuse), plus a unique GUID of their own.
      const gameA = await makeGameRoot('gameA', [GUID_A, GUID_SHARED]);
      const gameB = await makeGameRoot('gameB', [GUID_B, GUID_SHARED]);
      roots.push(gameA, gameB);

      const entries = await buildCatalog([gameA, gameB]);
      const guids = new Set(entries.map((e) => e.guid.toLowerCase()));

      // Each game's UNIQUE asset survives -- the collision is NOT fatal for
      // unrelated assets (the old behavior returned []).
      expect(guids.has(GUID_A)).toBe(true);
      expect(guids.has(GUID_B)).toBe(true);
      // The shared GUID appears exactly once (dedup keep-first), not zero.
      expect(entries.filter((e) => e.guid.toLowerCase() === GUID_SHARED)).toHaveLength(1);
    });

    it('no collision: per-root fast path is unaffected (all rows present)', async () => {
      const gameA = await makeGameRoot('gameA-clean', [GUID_A]);
      const gameB = await makeGameRoot('gameB-clean', [GUID_B]);
      roots.push(gameA, gameB);

      const entries = await buildCatalog([gameA, gameB]);
      const guids = new Set(entries.map((e) => e.guid.toLowerCase()));
      expect(guids.has(GUID_A)).toBe(true);
      expect(guids.has(GUID_B)).toBe(true);
      expect(entries).toHaveLength(2);
    });
  });
}

{
  // ─── AC-6/AC-7 integration: catalog row sourcePath with resolveAssetSource (w15) ───

  const AC67_IMAGE_GUID = '019e2cc6-0c86-79da-aa76-b0984c86f101';
  const ONE_BYTE_FILE = new Uint8Array([0xff]);

  function ac67ImageMeta(source?: string): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'image',
      source,
      importSettings: { colorSpace: 'srgb', mipmap: 'auto' },
      subAssets: [{ guid: AC67_IMAGE_GUID, sourceIndex: 0, kind: 'texture' }],
    });
  }

  describe('w15-AC-6-catalog-row-sourcepath.test.ts', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-ac6-'));
      process.chdir(tmpRoot);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('AC-6: explicit source=test.png → catalog row sourcePath endswith test.png', async () => {
      await writeFile(join(tmpRoot, 'test.png.meta.json'), ac67ImageMeta('test.png'));
      await writeFile(join(tmpRoot, 'test.png'), ONE_BYTE_FILE);

      const result = await buildCatalogStrict([tmpRoot]);
      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(1);
      const row = result.catalog[0];
      expect(row).toBeDefined();
      if (row) {
        expect(row.sourcePath.endsWith('test.png')).toBe(true);
        expect(row.kind).toBe('texture');
        expect(row.guid.toLowerCase()).toBe(AC67_IMAGE_GUID);
      }
    });

    it('AC-6: omitted source (=derive) → catalog row sourcePath ends with derived filename', async () => {
      // meta file: Inter.atlas.png.meta.json — derived source = Inter.atlas.png
      await writeFile(join(tmpRoot, 'Inter.atlas.png.meta.json'), ac67ImageMeta(undefined));
      await writeFile(join(tmpRoot, 'Inter.atlas.png'), ONE_BYTE_FILE);

      const result = await buildCatalogStrict([tmpRoot]);
      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(1);
      const row = result.catalog[0];
      expect(row).toBeDefined();
      if (row) {
        expect(row.sourcePath.endsWith('Inter.atlas.png')).toBe(true);
      }
    });

    it('AC-6: @name/ path prefix → catalog row sourcePath resolves into declared path dir', async () => {
      // path-table dir lives OUTSIDE the scan root (the whole point of @name/
      // is cross-directory reference). Declared in package.json#forgeax.assets.paths.
      const sharedDir = join(tmpRoot, 'shared-lib', 'assets');
      await mkdir(sharedDir, { recursive: true });
      await writeFile(join(sharedDir, 'cross.png'), ONE_BYTE_FILE);
      await writeFile(
        join(tmpRoot, 'package.json'),
        JSON.stringify({
          name: 'ac6-paths-tmp',
          forgeax: { assets: { paths: { shared: 'shared-lib/assets' } } },
        }),
      );
      const scanRoot = join(tmpRoot, 'metas');
      await mkdir(scanRoot, { recursive: true });
      await writeFile(join(scanRoot, 'cross.png.meta.json'), ac67ImageMeta('@shared/cross.png'));

      const result = await buildCatalogStrict([scanRoot]);
      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(1);
      const row = result.catalog[0];
      expect(row).toBeDefined();
      if (row) {
        expect(row.sourcePath.endsWith('shared-lib/assets/cross.png')).toBe(true);
        expect(row.guid.toLowerCase()).toBe(AC67_IMAGE_GUID);
      }
    });

    it('AC-7: relative path sub/dir/tex.png resolved correctly in catalog', async () => {
      const subDir = join(tmpRoot, 'sub', 'dir');
      await mkdir(subDir, { recursive: true });
      await writeFile(
        join(subDir, 'tex.png.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: 'tex.png',
          importSettings: {},
          subAssets: [{ guid: AC67_IMAGE_GUID, sourceIndex: 0, kind: 'texture' }],
        }),
      );
      await writeFile(join(subDir, 'tex.png'), ONE_BYTE_FILE);

      const result = await buildCatalogStrict([tmpRoot]);
      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(1);
      const row = result.catalog[0];
      expect(row).toBeDefined();
      if (row) {
        const absSourcePath = join(tmpRoot, row.sourcePath);
        expect(absSourcePath.endsWith('tex.png')).toBe(true);
      }
    });
  });
}

{
  // ─── P2: drop the importer-key whitelist wall; fold is driven by the
  //     registered-importer set (feat-20260629 M4 / w9) ───
  //
  // Red baseline: a host importer key (not in the former 5-value whitelist)
  // is rejected by `catalog-meta-unfoldable-importer`. After w11/w12 the
  // wall is gone and the fold layer defaults to passing `sub.kind` through
  // for any registered host importer; an unregistered importer key produces
  // a raw-source row instead of an error (AC-08).
  //
  // The 3rd `buildCatalog` / `buildCatalogStrict` arg is the set of
  // registered host importer keys (derived from the ImporterRegistry). The
  // engine-built-in arms (image / gltf / fbx / audio / font) fold
  // unconditionally and need no entry in this set.

  const HOST_GUID_A = '019e4000-0c86-79da-aa76-b0984c860a01';
  const HOST_GUID_B = '019e4000-0c86-79da-aa76-b0984c860a02';
  const ENGINE_IMG_GUID = '019e4000-0c86-79da-aa76-b0984c860a03';
  const UNREG_GUID = '019e4000-0c86-79da-aa76-b0984c860a04';
  const ONE_BYTE = new Uint8Array([0xff]);

  function hostMeta(guid: string, subKind: string, source: string): string {
    return JSON.stringify({
      schemaVersion: '1.0.0',
      kind: 'external-asset-package',
      importer: 'reel-game',
      source,
      importSettings: {},
      subAssets: [{ guid, sourceIndex: 0, kind: subKind }],
    });
  }

  describe('build-catalog-host-importer-passthrough.test.ts (w9)', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-host-fold-'));
      process.chdir(tmpRoot);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) registered host importer key folds: sub.kind passes through to a pack-index row', async () => {
      await writeFile(
        join(tmpRoot, 'level.reel.meta.json'),
        hostMeta(HOST_GUID_A, 'reel-level', 'level.reel'),
      );
      await writeFile(join(tmpRoot, 'level.reel'), ONE_BYTE);

      const result = await buildCatalogStrict([tmpRoot], '/', new Set(['reel-game']));

      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(1);
      const row = result.catalog[0];
      expect(row?.guid.toLowerCase()).toBe(HOST_GUID_A);
      // Default passthrough: the host sub.kind becomes the pack-index kind
      // verbatim (no engine remap, no whitelist gate).
      expect(row?.kind).toBe('reel-level');
      expect(row?.relativeUrl.endsWith('level.reel')).toBe(true);
      expect(row?.sourcePath.endsWith('level.reel')).toBe(true);
    });

    it('(b) engine built-in importer (image) still folds with zero regression after the wall is gone', async () => {
      await writeFile(
        join(tmpRoot, 'wood.jpg.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: 'wood.jpg',
          importSettings: { colorSpace: 'srgb', mipmap: 'auto' },
          subAssets: [{ guid: ENGINE_IMG_GUID, sourceIndex: 0, kind: 'texture' }],
        }),
      );
      await writeFile(join(tmpRoot, 'wood.jpg'), ONE_BYTE);

      // Note: image is an engine built-in arm; it must fold even when the
      // host registered-key set is empty.
      const result = await buildCatalogStrict([tmpRoot], '/', new Set());

      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(1);
      expect(result.catalog[0]?.kind).toBe('texture');
      expect(result.catalog[0]?.metadata?.kind).toBe('texture');
    });

    it('(c) unregistered importer key produces a raw-source row, not an error (AC-08)', async () => {
      await writeFile(
        join(tmpRoot, 'mystery.blob.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'not-wired',
          source: 'mystery.blob',
          importSettings: {},
          subAssets: [{ guid: UNREG_GUID, sourceIndex: 0, kind: 'mystery' }],
        }),
      );
      await writeFile(join(tmpRoot, 'mystery.blob'), ONE_BYTE);

      // Empty registered set -> 'not-wired' is unregistered.
      const result = await buildCatalogStrict([tmpRoot], '/', new Set());

      // AC-08: skip fold + keep a raw-source row (no catalog error). The row
      // preserves the source so the runtime can still resolve / fall back.
      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(1);
      const row = result.catalog[0];
      expect(row?.guid.toLowerCase()).toBe(UNREG_GUID);
      expect(row?.relativeUrl.endsWith('mystery.blob')).toBe(true);
      expect(row?.sourcePath.endsWith('mystery.blob')).toBe(true);
    });

    it('(d) dev path (buildCatalog) and build path (buildCatalogStrict) agree on the same host sidecar', async () => {
      await writeFile(
        join(tmpRoot, 'a.reel.meta.json'),
        hostMeta(HOST_GUID_A, 'reel-level', 'a.reel'),
      );
      await writeFile(join(tmpRoot, 'a.reel'), ONE_BYTE);
      await writeFile(
        join(tmpRoot, 'b.reel.meta.json'),
        hostMeta(HOST_GUID_B, 'reel-actor', 'b.reel'),
      );
      await writeFile(join(tmpRoot, 'b.reel'), ONE_BYTE);

      const keys = new Set(['reel-game']);
      const devRows = await buildCatalog([tmpRoot], '/', keys);
      const buildResult = await buildCatalogStrict([tmpRoot], '/', keys);

      expect(buildResult.errors).toHaveLength(0);
      const norm = (rows: readonly PackIndexEntry[]) =>
        [...rows]
          .map((r) => ({ guid: r.guid.toLowerCase(), kind: r.kind, sourcePath: r.sourcePath }))
          .sort((x, y) => x.guid.localeCompare(y.guid));
      expect(norm(devRows)).toEqual(norm(buildResult.catalog));
      // Both kinds passed through verbatim.
      const kinds = new Set(devRows.map((r) => r.kind));
      expect(kinds).toEqual(new Set(['reel-level', 'reel-actor']));
    });

    it('(f) unregistered importer: dev path and build path both keep a raw-source row, no error (AC-08 consistency, w10)', async () => {
      await writeFile(
        join(tmpRoot, 'thing.blob.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'unwired-host',
          source: 'thing.blob',
          importSettings: {},
          subAssets: [{ guid: HOST_GUID_B, sourceIndex: 0, kind: 'thing' }],
        }),
      );
      await writeFile(join(tmpRoot, 'thing.blob'), ONE_BYTE);

      const empty = new Set<string>();
      const devRows = await buildCatalog([tmpRoot], '/', empty);
      const buildResult = await buildCatalogStrict([tmpRoot], '/', empty);

      // No catalog error on either path (unregistered is a skip-fold +
      // raw-source-row case, NOT an unfoldable error).
      expect(buildResult.errors).toHaveLength(0);
      expect(devRows).toHaveLength(1);
      expect(buildResult.catalog).toHaveLength(1);
      expect(devRows[0]?.guid.toLowerCase()).toBe(HOST_GUID_B);
      expect(buildResult.catalog[0]?.guid.toLowerCase()).toBe(HOST_GUID_B);
      expect(devRows[0]?.sourcePath).toBe(buildResult.catalog[0]?.sourcePath);
    });

    it('(g) D-7: a registered host importer whose sub.kind collides with an engine built-in kind reports a conflict (no silent override)', async () => {
      // 'texture' is an engine built-in kind (the runtime textureLoader owns
      // it). A host importer that passes 'texture' through must NOT silently
      // shadow the engine kind -- the fold layer surfaces a structured
      // conflict error instead.
      await writeFile(
        join(tmpRoot, 'clash.reel.meta.json'),
        hostMeta(HOST_GUID_A, 'texture', 'clash.reel'),
      );
      await writeFile(join(tmpRoot, 'clash.reel'), ONE_BYTE);

      const result = await buildCatalogStrict([tmpRoot], '/', new Set(['reel-game']));

      expect(result.catalog).toHaveLength(0);
      expect(result.errors.length).toBeGreaterThan(0);
      const conflict = result.errors[0];
      expect(conflict?.code).toBe('catalog-host-kind-conflict');
      expect(conflict?.message).toContain('texture');
    });

    it('(e) feat-20260630: an .hdr equirect sidecar folds to kind:"equirect" + rgba16float', async () => {
      // The retired cube-texture special arm is gone; the .hdr single-source
      // equirect arm folds to a kind:'equirect' row the runtime equirectLoader
      // consumes. (6-PNG cube folding was deleted with the cube-texture kind.)
      const EQUIRECT_GUID = '019e4000-0c86-79da-aa76-b0984c860a05';
      await writeFile(
        join(tmpRoot, 'sky.hdr.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: 'sky.hdr',
          importSettings: { colorSpace: 'linear', mipmap: 'none' },
          subAssets: [{ guid: EQUIRECT_GUID, sourceIndex: 0, kind: 'equirect' }],
        }),
      );
      await writeFile(join(tmpRoot, 'sky.hdr'), ONE_BYTE);

      const result = await buildCatalogStrict([tmpRoot], '/', new Set());

      expect(result.errors).toHaveLength(0);
      expect(result.catalog).toHaveLength(1);
      const row = result.catalog[0];
      expect(row?.kind).toBe('equirect');
      expect(row?.metadata?.kind).toBe('texture');
      if (row?.metadata?.kind === 'texture') {
        expect(row.metadata.format).toBe('rgba16float');
      }
    });
  });
}

{
  // ─── .hdr equirect zero-regression (feat-20260630 M1 / w6) ───
  //
  // The image arm's .hdr equirect path must survive the host default-passthrough
  // path untouched: a `.hdr` equirect sidecar folds to kind:'equirect' +
  // rgba16float regardless of registered host importers. The three real
  // submodule .hdr sidecars (newport_loft x2, sky) are folded here to lock
  // their post-migration output (kind:'equirect') against drift.

  const REAL_HDR_SIDECARS = [
    {
      label: 'learn-opengl/textures/newport_loft.hdr',
      guid: '019e4a26-3c29-7420-af5d-20f2724a16b0',
      source: 'newport_loft.hdr',
    },
    {
      label: 'learn-opengl/textures/hdr/newport_loft.hdr',
      guid: '019ee3e0-4be6-7f22-88f2-653ebbc5a207',
      source: 'newport_loft.hdr',
    },
    {
      label: 'demo-assets/template-game-default/sky.hdr',
      guid: '81eec382-392f-5a93-8998-0ecf11ef7990',
      source: 'sky.hdr',
    },
  ] as const;

  function realHdrEquirectMeta(guid: string, source: string): string {
    // Byte-shape mirror of the migrated submodule sidecars (w9): kind:'equirect',
    // no cubeFaceSize / specularMipLevels (D-6 dropped the projection hyperparams).
    return JSON.stringify({
      kind: 'external-asset-package',
      importer: 'image',
      schemaVersion: '1.0.0',
      source,
      importSettings: {
        colorSpace: 'linear',
        mipmap: 'auto',
        addressMode: 'clamp-to-edge',
        filterMode: 'linear',
      },
      subAssets: [{ guid, sourceIndex: 0, kind: 'equirect' }],
    });
  }

  const W6_ONE_BYTE = new Uint8Array([0xff]);

  describe('build-catalog-hdr-equirect-zero-regression.test.ts (w6)', () => {
    let originalCwd: string;
    let tmpRoot: string;

    beforeEach(async () => {
      originalCwd = process.cwd();
      tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w6-hdr-'));
      process.chdir(tmpRoot);
    });

    afterEach(async () => {
      process.chdir(originalCwd);
      await rm(tmpRoot, { recursive: true, force: true });
    });

    it('(a) the 3 real .hdr equirect sidecars fold to kind:"equirect" + rgba16float (host importer present)', async () => {
      // Even with a host importer registered, the engine image arm owns 'image'
      // and the .hdr equirect path must be unaffected.
      const registered = new Set(['reel-game']);
      for (const sc of REAL_HDR_SIDECARS) {
        await writeFile(
          join(tmpRoot, `${sc.source}.meta.json`),
          realHdrEquirectMeta(sc.guid, sc.source),
        );
        await writeFile(join(tmpRoot, sc.source), W6_ONE_BYTE);

        const result = await buildCatalogStrict([tmpRoot], '/', registered);
        expect(result.errors).toHaveLength(0);
        expect(result.catalog).toHaveLength(1);
        const row = result.catalog[0];
        expect(row?.guid.toLowerCase()).toBe(sc.guid);
        expect(row?.kind).toBe('equirect');
        expect(row?.metadata?.kind).toBe('texture');
        if (row?.metadata?.kind === 'texture') {
          expect(row.metadata.format).toBe('rgba16float');
          expect(row.metadata.colorSpace).toBe('linear');
        }

        await rm(join(tmpRoot, `${sc.source}.meta.json`));
        await rm(join(tmpRoot, sc.source));
      }
    });

    it('(b) no pack-index row carries kind:"cube-texture" anymore', async () => {
      const sc = REAL_HDR_SIDECARS[0];
      await writeFile(
        join(tmpRoot, `${sc.source}.meta.json`),
        realHdrEquirectMeta(sc.guid, sc.source),
      );
      await writeFile(join(tmpRoot, sc.source), W6_ONE_BYTE);

      const result = await buildCatalogStrict([tmpRoot], '/', new Set());
      expect(result.errors).toHaveLength(0);
      for (const row of result.catalog) {
        expect(row.kind).not.toBe('cube-texture');
      }
    });
  });
}

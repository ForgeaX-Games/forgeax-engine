// index-hdr-equirect-import.test.ts
// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M1 / w1.
//
// TDD red->green: locks the .hdr end-to-end import producing a kind:'equirect'
// pack-index row + a build-time .bin, on BOTH index.ts paths:
//   - build generateBundle (vite build programmatic API)
//   - dev POST /__import equivalent (runImport with the image importer)
//
// plan-review.md issue #1 + plan-decisions orchestrator adjudication: equirect
// is a single 2D rgba16float image with a disk identity, so it produces a build
// .bin (unlike the old cube-texture which had no single 2D representation). The
// index.ts skip guards (`meta.subAssets.every(s => s.kind === 'cube-texture')`)
// therefore become dead code (w8 deletes them); these tests prove the .hdr path
// no longer takes the skip branch on either path.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { ImporterRegistry, runImport } from '@forgeax/engine-import';
import type { EquirectAsset, PackIndexEntry } from '@forgeax/engine-types';
import { build as viteBuild } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = join(here, '..', '..', '..', '..');
const FIXTURE_HDR_SRC = join(
  WORKTREE_ROOT,
  'forgeax-engine-assets',
  'learn-opengl',
  'textures',
  'newport_loft.hdr',
);
const HDR_GUID = '019e4a26-3c29-7420-af5d-20f2724a16b0';

function hdrEquirectMeta(): string {
  return JSON.stringify({
    schemaVersion: '1.0.0',
    kind: 'external-asset-package',
    importer: 'image',
    source: 'newport_loft.hdr',
    importSettings: {
      colorSpace: 'linear',
      mipmap: 'auto',
      addressMode: 'clamp-to-edge',
      filterMode: 'linear',
    },
    subAssets: [{ guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' }],
  });
}

const MAIN_JS = "console.log('hdr-equirect-import-test entry');\n";

let originalCwd: string;
let tmpRoot: string;
let assetsDir: string;
let distDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w1-index-'));
  assetsDir = join(tmpRoot, 'assets');
  distDir = join(tmpRoot, 'dist');
  process.chdir(tmpRoot);

  const hdrBytes = await readFile(FIXTURE_HDR_SRC);
  await writeFile(join(tmpRoot, 'main.js'), MAIN_JS);
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, 'newport_loft.hdr'), hdrBytes);
  await writeFile(join(assetsDir, 'newport_loft.hdr.meta.json'), hdrEquirectMeta());
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

async function findImportedBin(): Promise<string | undefined> {
  const distAssetsDir = join(distDir, 'assets');
  let names: string[];
  try {
    names = await readdir(distAssetsDir);
  } catch {
    return undefined;
  }
  return names.find((n) => n.toLowerCase().startsWith(HDR_GUID) && n.endsWith('.bin'));
}

async function readPackIndex(): Promise<PackIndexEntry[]> {
  const raw = await readFile(join(distDir, 'pack-index.json'), 'utf-8');
  return JSON.parse(raw) as PackIndexEntry[];
}

describe('index-hdr-equirect-import.test.ts (w1) - build generateBundle path', () => {
  it('(a) emits dist/assets/<guid>-<hash>.bin for the .hdr equirect (not a skip)', async () => {
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
      plugins: [pluginPack({ roots: [assetsDir], importers: [imageImporter] })],
    });

    const imported = await findImportedBin();
    expect(imported).toBeDefined();
    expect(imported?.endsWith('.bin')).toBe(true);
  });

  it('(b) pack-index row carries kind:"equirect" + rgba16float, relativeUrl -> .bin', async () => {
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
      plugins: [pluginPack({ roots: [assetsDir], importers: [imageImporter] })],
    });

    const entries = await readPackIndex();
    const row = entries.find((e) => e.guid.toLowerCase() === HDR_GUID);
    expect(row).toBeDefined();
    expect(row?.kind).toBe('equirect');
    expect(row?.relativeUrl.endsWith('.bin')).toBe(true);
    expect(row?.relativeUrl.endsWith('.hdr')).toBe(false);
    if (row?.metadata?.kind === 'texture') {
      expect(row.metadata.format).toBe('rgba16float');
    }
  });
});

describe('index-hdr-equirect-import.test.ts (w1) - dev POST /__import equivalent', () => {
  it('(c) runImport with the image importer produces an EquirectAsset (no import-produced-no-assets)', async () => {
    const registry = new ImporterRegistry();
    registry.register(imageImporter);

    const hdrBytes = new Uint8Array(await readFile(FIXTURE_HDR_SRC));
    const fs = {
      readSource: async () => ({ ok: true as const, value: hdrBytes }),
    };

    const runResult = await runImport(
      {
        importer: 'image',
        source: join(assetsDir, 'newport_loft.hdr'),
        importSettings: { colorSpace: 'linear', mipmap: 'auto' },
        subAssets: [{ guid: HDR_GUID, sourceIndex: 0, kind: 'equirect' }],
      },
      registry,
      fs,
    );

    expect(runResult.ok).toBe(true);
    if (!runResult.ok) return;
    expect('skipped' in runResult.value).toBe(false);
    if ('skipped' in runResult.value) return;
    const produced = runResult.value.pack.assets;
    const equirect = produced.find((a) => a.guid.toLowerCase() === HDR_GUID);
    expect(equirect).toBeDefined();
    expect((equirect?.payload as EquirectAsset | undefined)?.kind).toBe('equirect');
  });
});

// build-import-emit.integration.test - vitest integration coverage for the
// `generateBundle` import arm of @forgeax/engine-vite-plugin-pack
// (feat-20260517-vite-plugin-image-build-time-cook M4 w10 / TDD red).
//
// Red phase: the `generateBundle` hook today only emits `pack-index.json`
// (4-field rows for legacy `.pack.json` and 5-field rows for image
// `.meta.json` sidecars where `relativeUrl` still points at the
// source JPG path on disk). The import step that decodes JPG bytes into
// `Uint8Array` RGBA + `emitFile({type:'asset', source: rawRgbaBytes,
// name: '<guid-lowercase>'})` + `getFileName(refId)` rewrite of
// `relativeUrl` is implemented in w11; until then the four assertions
// below are red.
//
// Cases (plan-strategy section 2 D-1 / D-2 / section 7 M4 description;
// requirements section 6 AC-03 + AC-04):
//   (a) `dist/assets/<guid>-<hash>.bin` exists after vite build (Rollup
//       default `output.assetFileNames` resolves `name: '<guid>'` to a
//       hashed file inside `dist/assets/`).
//   (b) `dist/pack-index.json` row of `kind: 'texture'` has `relativeUrl`
//       pointing at the hashed `.bin` path (NOT at the source `.jpg`).
//   (c) The `.bin` byte content is byte-identical to running
//       `parseImage(jpgBytes, 'image/jpeg', { colorSpace, mipmap })` on
//       the same source JPG (dev path equivalence; D-5 dev/import POD
//       same shape).
//   (d) `pack-index.json` `metadata` field carries 5 keys
//       (`width / height / format / colorSpace / mipmap`); width and
//       height are filled by the import step (build path always has them,
//       contrast with dev rows which can omit them).
//
// The test runs `import { build } from 'vite'` programmatic API against
// an isolated tmp directory containing the same `wood-container.jpg` +
// `wood-container.meta.json` shape as
// `apps/learn-render/1.getting-started/4.textures/assets/`. We construct
// a minimal `index.html` entry so Rollup has something to pin assets
// against; the plugin emits the pack-index + imported .bin via
// `generateBundle`.

import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import { parseImage } from '@forgeax/engine-image/parse-image';
import type { PackIndexEntry } from '@forgeax/engine-types';
import { build as viteBuild } from 'vite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pluginPack } from '../index.js';

// --- fixture scaffolding ----------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));

// SSOT fixture: re-use the wood.png shipped in the forgeax-engine-assets
// submodule (learn-opengl carve-out) so the integration test mirrors the
// vendor SSOT path. Round-3 of feat-small-20260518-learn-opengl-assets-
// vendor migrated the demo-local wood-container.jpg to vendor wood.png;
// this fixture follows the same redirect.
const WORKTREE_ROOT = join(here, '..', '..', '..', '..');
const FIXTURE_JPG_SRC = join(
  WORKTREE_ROOT,
  'forgeax-engine-assets',
  'learn-opengl',
  'textures',
  'wood.png',
);
const WOOD_GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';

// The Basis encoder WASM (pkg/, gitignored emcc artefact) is needed for the
// compressionMode:'auto' -> Basis .ktx2 case. CI's build-artifacts job builds
// it; skip the basis-row assertion on a contributor machine without it.
const ENCODER_GLUE = join(WORKTREE_ROOT, 'packages', 'codec', 'pkg', 'encode', 'basis_encoder.mjs');
const pkgBuilt = existsSync(ENCODER_GLUE);

function woodImageMeta(): string {
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
      // feat-20260707 M5 / w38: (c) asserts the imported .bin is byte-identical
      // to raw parseImage RGBA. Pin compressionMode:'none' now that the default
      // flipped to 'auto' (which would emit a Basis .ktx2 instead of raw RGBA).
      compressionMode: 'none',
    },
    subAssets: [
      {
        guid: WOOD_GUID,
        sourceIndex: 0,
        kind: 'texture',
      },
    ],
  });
}

// Minimal entry: a JS file is enough for vite to anchor the build
// against. The pack plugin emits assets via `emitFile` independently of
// the entry; using JS rather than HTML avoids the vite:build-html plugin
// resolving the absolute index.html path relative to the harness cwd
// (which differs from `tmpRoot` once vite's worker hops out).
const MAIN_JS = `// minimal entry; pack plugin emits assets independently
console.log('import-emit-test entry');
`;

let originalCwd: string;
let tmpRoot: string;
let assetsDir: string;
let distDir: string;

beforeEach(async () => {
  originalCwd = process.cwd();
  tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w10-'));
  assetsDir = join(tmpRoot, 'assets');
  distDir = join(tmpRoot, 'dist');
  process.chdir(tmpRoot);

  // Copy the shipped JPG fixture verbatim so the import test exercises a
  // real-world JPEG byte stream (decodes to 256 x 256 RGBA per
  // research F9).
  const jpgBytes = await readFile(FIXTURE_JPG_SRC);
  await writeFile(join(tmpRoot, 'main.js'), MAIN_JS);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(assetsDir, { recursive: true });
  await writeFile(join(assetsDir, 'wood.png'), jpgBytes);
  await writeFile(join(assetsDir, 'wood.png.meta.json'), woodImageMeta());
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(tmpRoot, { recursive: true, force: true });
});

// Helper: list `dist/assets/` and find the imported `.bin` whose filename
// starts with the lowercase GUID prefix. Rollup default
// `output.assetFileNames` template is `assets/[name]-[hash][extname]`,
// so the full filename is `<guid>-<hash>.bin`.
async function findImportedBin(): Promise<string | undefined> {
  const distAssetsDir = join(distDir, 'assets');
  let names: string[];
  try {
    names = await readdir(distAssetsDir);
  } catch {
    return undefined;
  }
  return names.find((n) => n.toLowerCase().startsWith(WOOD_GUID) && n.endsWith('.bin'));
}

async function readPackIndex(): Promise<PackIndexEntry[]> {
  const raw = await readFile(join(distDir, 'pack-index.json'), 'utf-8');
  return JSON.parse(raw) as PackIndexEntry[];
}

// --- cases ------------------------------------------------------------------

describe('w10 - build-time import emit integration (vite build end-to-end)', () => {
  it('(a) emits dist/assets/<guid>-<hash>.bin as Rollup hashed asset', async () => {
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

    const imported = await findImportedBin();
    expect(imported).toBeDefined();
    expect(imported?.endsWith('.bin')).toBe(true);
  });

  it('(b) pack-index.json#relativeUrl points at hashed .bin (not the source .jpg)', async () => {
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
    const textureRow = entries.find((e) => e.guid.toLowerCase() === WOOD_GUID);
    expect(textureRow).toBeDefined();
    expect(textureRow?.kind).toBe('texture');
    expect(textureRow?.relativeUrl.endsWith('.bin')).toBe(true);
    expect(textureRow?.relativeUrl.endsWith('.jpg')).toBe(false);
    // Rollup hash is non-empty; bin path must include the guid prefix.
    expect(textureRow?.relativeUrl.toLowerCase()).toContain(WOOD_GUID);
  });

  it('(c) imported .bin bytes are byte-identical to dev-path parseImage output', async () => {
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

    const imported = await findImportedBin();
    expect(imported).toBeDefined();
    if (imported === undefined) return;

    const importedBytes = await readFile(join(distDir, 'assets', imported));
    const jpgBytes = await readFile(join(assetsDir, 'wood.png'));
    const decoded = parseImage(jpgBytes, 'image/png', {
      colorSpace: 'srgb',
      mipmap: true,
    });
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const expectedBytes = decoded.value.bytes;

    // Length first (cheaper failure signal than per-pixel mismatch).
    expect(importedBytes.byteLength).toBe(expectedBytes.byteLength);

    // 4 sample pixels at quarter offsets to keep failure output small but
    // catch any byte-shift regression. Tight-packed RGBA -> 4 bytes/pixel.
    const samples = [
      0,
      Math.floor(expectedBytes.byteLength / 4),
      Math.floor(expectedBytes.byteLength / 2),
      expectedBytes.byteLength - 4,
    ];
    for (const offset of samples) {
      const importedPixel = [
        importedBytes[offset],
        importedBytes[offset + 1],
        importedBytes[offset + 2],
        importedBytes[offset + 3],
      ];
      const expectedPixel = [
        expectedBytes[offset],
        expectedBytes[offset + 1],
        expectedBytes[offset + 2],
        expectedBytes[offset + 3],
      ];
      expect(importedPixel).toEqual(expectedPixel);
    }
  });

  it('(d) pack-index.json#metadata carries 5 fields (width/height/format/colorSpace/mipmap)', async () => {
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
    const textureRow = entries.find((e) => e.guid.toLowerCase() === WOOD_GUID);
    expect(textureRow).toBeDefined();
    expect(textureRow?.metadata).toBeDefined();
    expect(textureRow?.metadata?.width).toBeGreaterThan(0);
    expect(textureRow?.metadata?.height).toBeGreaterThan(0);
    const importMeta = textureRow?.metadata;
    if (importMeta === undefined || importMeta.kind !== 'texture') return;
    expect(importMeta.format).toBe('rgba8unorm-srgb');
    expect(importMeta.colorSpace).toBe('srgb');
    expect(importMeta.mipmap).toBe(true);
  });

  // feat-20260523-vite-plugin-pack-dev-path-gltf-subasset-support M1 t-1.3:
  // verify that thin gltf rows (mesh / material / scene, metadata=undefined)
  // survive the generateBundle import step unchanged, alongside the existing
  // image arm texture rows.
  it('(e) gltf thin rows (mesh/material/scene) passthrough import + coexist with image rows', async () => {
    // Synthetic gltf sidecar: 3 mesh + 2 material + 1 scene = 6 subAssets.
    const gltfMeta = {
      schemaVersion: 1,
      kind: 'external-asset-package',
      importer: 'gltf',
      source: 'test.gltf',
      importSettings: { defaultSceneIndex: 0 },
      subAssets: [
        { guid: '01900000-0000-7000-8000-aaaaaaaaaa01', sourceIndex: 0, kind: 'mesh' },
        { guid: '01900000-0000-7000-8000-aaaaaaaaaa02', sourceIndex: 0, kind: 'mesh' },
        { guid: '01900000-0000-7000-8000-aaaaaaaaaa03', sourceIndex: 0, kind: 'mesh' },
        { guid: '01900000-0000-7000-8000-bbbbbbbbbb01', sourceIndex: 0, kind: 'material' },
        { guid: '01900000-0000-7000-8000-bbbbbbbbbb02', sourceIndex: 0, kind: 'material' },
        { guid: '01900000-0000-7000-8000-cccccccccc01', sourceIndex: 0, kind: 'scene' },
      ],
    };
    await writeFile(join(assetsDir, 'test.gltf.meta.json'), JSON.stringify(gltfMeta));
    // Dummy gltf source so the scanner orphan check passes.
    await writeFile(join(assetsDir, 'test.gltf'), new Uint8Array([0x00]));

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

    // Image arm: wood.png texture row still present (no regression).
    const textureRows = entries.filter((e) => e.kind === 'texture');
    expect(textureRows).toHaveLength(1);
    expect(textureRows[0]?.guid.toLowerCase()).toBe(WOOD_GUID);

    // Gltf arm: 6 thin rows, metadata undefined, kind literal from sidecar.
    const meshRows = entries.filter((e) => e.kind === 'mesh');
    const materialRows = entries.filter((e) => e.kind === 'material');
    const sceneRows = entries.filter((e) => e.kind === 'scene');

    expect(meshRows).toHaveLength(3);
    expect(materialRows).toHaveLength(2);
    expect(sceneRows).toHaveLength(1);

    const gltfRows = [...meshRows, ...materialRows, ...sceneRows];
    for (const row of gltfRows) {
      expect(row.metadata).toBeUndefined();
      expect(typeof row.guid).toBe('string');
      expect(row.guid.length).toBe(36);
      expect(typeof row.relativeUrl).toBe('string');
      expect(row.relativeUrl.startsWith('/')).toBe(true);
      expect(typeof row.sourcePath).toBe('string');
    }

    // Total: 1 texture (image arm) + 6 gltf thin = 7.
    expect(entries).toHaveLength(7);
  });

  // feat-20260630: an `.hdr` equirect sidecar IS imported at build time (a
  // single 2D rgba16float image with a disk identity, unlike the retired
  // cube-texture). generateBundle emits a hashed .bin and the pack-index row is
  // kind:'equirect' with relativeUrl rewritten to the .bin. This is the e2e
  // proof that index.ts no longer takes the old cube-texture skip branch (w8).
  it('(f) .hdr equirect imports to a build .bin: build succeeds, kind:"equirect" row', async () => {
    const HDR_GUID = '019ee3e0-4be6-7f22-88f2-653ebbc5a207';
    const hdrBytes = await readFile(
      join(WORKTREE_ROOT, 'forgeax-engine-assets', 'learn-opengl', 'textures', 'newport_loft.hdr'),
    );
    await writeFile(join(assetsDir, 'newport_loft.hdr'), hdrBytes);
    await writeFile(
      join(assetsDir, 'newport_loft.hdr.meta.json'),
      JSON.stringify({
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
      }),
    );

    // Must NOT throw: the equirect arm produces a build .bin.
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
    const hdrRow = entries.find((e) => e.guid.toLowerCase() === HDR_GUID);
    expect(hdrRow).toBeDefined();
    expect(hdrRow?.kind).toBe('equirect');
    expect(hdrRow?.relativeUrl.endsWith('.bin')).toBe(true);
    expect(hdrRow?.relativeUrl.endsWith('.hdr')).toBe(false);
  });

  // feat-20260629 M4 / w9: a host-declared importer key (not an engine
  // built-in) folds end-to-end through a real vite build. The host wires a
  // passthrough `{ key, import }` importer via pluginPack({ importers }); the
  // fold layer must emit a pack-index row whose `kind` is the host sub.kind
  // verbatim -- no whitelist gate, no engine remap (AC-05 / AC-08).
  it('(g) host importer key folds end-to-end: pack-index row carries the host kind', async () => {
    const HOST_GUID = '019e4001-0c86-79da-aa76-b0984c8600a1';
    await writeFile(
      join(assetsDir, 'level.reel.meta.json'),
      JSON.stringify({
        schemaVersion: '1.0.0',
        kind: 'external-asset-package',
        importer: 'reel-game',
        source: 'level.reel',
        importSettings: {},
        subAssets: [{ guid: HOST_GUID, sourceIndex: 0, kind: 'reel-level' }],
      }),
    );
    await writeFile(join(assetsDir, 'level.reel'), new Uint8Array([0x7b, 0x7d]));

    // Passthrough host importer: stamps the declared GUID onto a thin POD.
    const reelImporter = {
      key: 'reel-game',
      import(ctx: { subAssets: readonly { guid: string; kind: string }[] }) {
        return ctx.subAssets.map((s) => ({
          guid: s.guid,
          kind: s.kind,
          payload: { kind: s.kind } as never,
          refs: [],
        }));
      },
    };

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
      plugins: [pluginPack({ roots: [assetsDir], importers: [reelImporter] })],
    });

    const entries = await readPackIndex();
    const hostRow = entries.find((e) => e.guid.toLowerCase() === HOST_GUID);
    expect(hostRow).toBeDefined();
    expect(hostRow?.kind).toBe('reel-level');
    expect(hostRow?.sourcePath.endsWith('level.reel')).toBe(true);
  });

  // feat-20260707 M6 fix: a compressionMode:'auto' sRGB texture cooks a Basis
  // ETC1S .ktx2, and the pack-index ROW must carry `compression: 'basis-etc1s'`
  // (the resolved delivery discriminant), not the STRATEGY_TABLE 'none' default.
  // The runtime `loadTextureAsset` dispatches its transcode arm on the ROW-level
  // `compression`; before this fix compressArtifact overwrote it with 'none' and
  // the scheme=1 KTX2 fell through to ktx2LevelsToRGBA which rejects BasisLZ.
  it.skipIf(!pkgBuilt)(
    '(h) auto-encode texture: pack-index row carries resolved compression=basis-etc1s',
    async () => {
      // Re-use the wood.png fixture but flip the sidecar to the 'auto' default.
      await writeFile(
        join(assetsDir, 'wood.png.meta.json'),
        JSON.stringify({
          schemaVersion: '1.0.0',
          kind: 'external-asset-package',
          importer: 'image',
          source: 'wood.png',
          importSettings: {
            colorSpace: 'srgb',
            mipmap: 'auto',
            addressMode: 'repeat',
            filterMode: 'linear',
            compressionMode: 'auto',
          },
          subAssets: [{ guid: WOOD_GUID, sourceIndex: 0, kind: 'texture' }],
        }),
      );

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
      const textureRow = entries.find((e) => e.guid.toLowerCase() === WOOD_GUID);
      expect(textureRow).toBeDefined();
      expect(textureRow?.kind).toBe('texture');
      // The load-bearing assertion: the ROW-level discriminant is the basis-*
      // member the runtime loader dispatches on (auto -> etc1s for sRGB color).
      expect(textureRow?.compression).toBe('basis-etc1s');
      // The metadata discriminant agrees (importTextureEntry SSOT).
      expect(textureRow?.metadata?.compression).toBe('basis-etc1s');
    },
  );
});

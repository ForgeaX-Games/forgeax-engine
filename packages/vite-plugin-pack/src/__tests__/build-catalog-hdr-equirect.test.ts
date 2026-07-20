// build-catalog-hdr-equirect.test.ts
// feat-20260630-equirect-kind-internalized-ibl-declarative-skyligh M1 / w1.
//
// TDD red->green: locks the build-catalog image arm folding a .hdr sidecar
// (subAssets[].kind === 'equirect') to a pack-index row with kind:'equirect'
// + rgba16float ImageMetadata. The prior behaviour remapped the .hdr cube
// sidecar to kind:'texture'; the 6-PNG cube else branch (kind:'cube-texture')
// is removed. research F-4 + plan-strategy D-1/D-8.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalogStrict } from '../build-catalog.js';

const REAL_HDR_SIDECARS = [
  {
    label: 'learn-opengl/textures/newport_loft.hdr',
    guid: '019e4a26-3c29-7420-af5d-20f2724a16b0',
    source: 'newport_loft.hdr',
  },
  {
    label: 'demo-assets/template-game-default/sky.hdr',
    guid: '81eec382-392f-5a93-8998-0ecf11ef7990',
    source: 'sky.hdr',
  },
] as const;

function equirectSidecar(guid: string, source: string): string {
  // Byte-shape mirror of the migrated submodule sidecars (w9): kind:'equirect',
  // no cubeFaceSize / specularMipLevels (D-6 removed the projection hyperparams).
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

const ONE_BYTE = new Uint8Array([0xff]);

describe('build-catalog-hdr-equirect.test.ts (w1)', () => {
  let originalCwd: string;
  let tmpRoot: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-vpp-w1-equirect-'));
    process.chdir(tmpRoot);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('(a) the real .hdr equirect sidecars fold to kind:"equirect" + rgba16float metadata', async () => {
    for (const sc of REAL_HDR_SIDECARS) {
      await writeFile(join(tmpRoot, `${sc.source}.meta.json`), equirectSidecar(sc.guid, sc.source));
      await writeFile(join(tmpRoot, sc.source), ONE_BYTE);

      const result = await buildCatalogStrict([tmpRoot], '/', new Set());
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

  it('(b) no pack-index row carries kind:"cube-texture" anymore (6-PNG remap removed)', async () => {
    const sc = REAL_HDR_SIDECARS[0];
    await writeFile(join(tmpRoot, `${sc.source}.meta.json`), equirectSidecar(sc.guid, sc.source));
    await writeFile(join(tmpRoot, sc.source), ONE_BYTE);

    const result = await buildCatalogStrict([tmpRoot], '/', new Set());
    expect(result.errors).toHaveLength(0);
    for (const row of result.catalog) {
      expect(row.kind).not.toBe('cube-texture');
    }
  });
});

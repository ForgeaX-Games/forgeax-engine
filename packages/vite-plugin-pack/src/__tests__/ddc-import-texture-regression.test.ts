// ddc-import-texture-regression.test.ts -- R-9 DDC amortization gate for the
// w38 'auto'-default flip.
//
// M5/w38 flipped the sidecar compressionMode default to 'auto', so every
// existing texture now cooks a Basis .ktx2 on import. That encode is expensive
// (w17-a drops it to the fastest effort tier, but it is still non-trivial). R-9
// option 1 relies on the build-time DDC to make that a ONE-TIME cost: a warm
// build with identical (source bytes, import settings incl compressionMode)
// must hit the cache and skip `imageImporter.import` (which owns the decode +
// Basis encode) entirely.
//
// This gate proves the two load-bearing DDC properties at the importTextureEntry
// integration layer (ddc-cache.unit.test.ts already covers keyFor/read/write in
// isolation):
//   (1) HIT: a second importTextureEntry call with identical (source, settings)
//       does NOT re-invoke imageImporter.import -- the DDC returns the previously
//       cooked bytes/metadata. Proven by spying on imageImporter.import and
//       asserting the call count does not grow, plus byte-identical output.
//   (2) RE-KEY: changing compressionMode changes the DDC key, so the second call
//       MISSES and re-imports -- no stale-cache poisoning across a mode flip.
//
// The 'auto' cases need the encoder WASM (pkg/, a gitignored emcc artifact,
// AC-12) and skip when it is not built; CI's build-artifacts job builds it. The
// 'none' case needs no WASM and always runs so the DDC hit mechanism is covered
// even on a contributor machine without emsdk.

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageImporter } from '@forgeax/engine-image/image-importer';
import type { ImageMetadata, PackIndexEntry } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importTextureEntry } from '../import-texture.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKTREE_ROOT = join(HERE, '..', '..', '..', '..');
const FIXTURE_PNG_SRC = join(
  WORKTREE_ROOT,
  'forgeax-engine-assets',
  'learn-opengl',
  'textures',
  'wood.png',
);
const ENCODER_GLUE = join(WORKTREE_ROOT, 'packages', 'codec', 'pkg', 'encode', 'basis_encoder.mjs');
const pkgBuilt = existsSync(ENCODER_GLUE);

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';

/** A texture pack-index row with the given compressionMode token in metadata. */
function textureEntry(
  sourceRel: string,
  compressionMode: NonNullable<ImageMetadata['compressionMode']>,
): PackIndexEntry {
  const metadata: ImageMetadata = {
    kind: 'texture',
    format: 'rgba8unorm-srgb',
    colorSpace: 'srgb',
    mipmap: true,
    compressionMode,
  };
  return {
    guid: GUID,
    relativeUrl: `/${sourceRel}`,
    kind: 'texture',
    sourcePath: sourceRel,
    metadata,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

describe('ddc-import-texture-regression.test.ts (R-9 / w38-a)', () => {
  let originalCwd: string;
  let tmpRoot: string;
  let sourceRel: string;
  let importSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tmpRoot = await mkdtemp(join(tmpdir(), 'forgeax-ddc-regr-'));
    process.chdir(tmpRoot);
    await mkdir(join(tmpRoot, 'assets'), { recursive: true });
    const png = await readFile(FIXTURE_PNG_SRC);
    sourceRel = relative(tmpRoot, join(tmpRoot, 'assets', 'wood.png'));
    await writeFile(join(tmpRoot, sourceRel), png);
    // Spy through (no mockImplementation): observe the decode+encode seam without
    // altering it. A DDC hit returns before this is reached, so the call count is
    // the direct witness of hit vs miss.
    importSpy = vi.spyOn(imageImporter, 'import');
  });

  afterEach(async () => {
    importSpy.mockRestore();
    process.chdir(originalCwd);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('HIT (compressionMode=none): second identical build skips imageImporter.import', async () => {
    const entry = textureEntry(sourceRel, 'none');

    const first = await importTextureEntry(entry, { cwd: tmpRoot });
    expect('bytes' in first).toBe(true);
    if (!('bytes' in first)) return;
    expect(importSpy).toHaveBeenCalledTimes(1); // cold: miss -> import ran

    const second = await importTextureEntry(entry, { cwd: tmpRoot });
    expect('bytes' in second).toBe(true);
    if (!('bytes' in second)) return;
    // Warm: the DDC hit returned before imageImporter.import -- call count did
    // not grow. This is the one-time-cost / amortization claim.
    expect(importSpy).toHaveBeenCalledTimes(1);
    // The cached bytes reconstruct the cooked output byte-for-byte.
    expect(bytesEqual(second.bytes, first.bytes)).toBe(true);
    expect(second.metadata).toEqual(first.metadata);
  });

  it('RE-KEY (compressionMode none -> auto): changed mode misses and re-imports', async () => {
    // Prime the cache under 'none'.
    const noneEntry = textureEntry(sourceRel, 'none');
    const primed = await importTextureEntry(noneEntry, { cwd: tmpRoot });
    expect('bytes' in primed).toBe(true);
    expect(importSpy).toHaveBeenCalledTimes(1);

    // Same source bytes, different compressionMode => different DDC key => miss.
    // (Uses 'etc1s' rather than 'auto' so this assertion needs no encoder WASM:
    // the point is that the compressionMode token participates in the key, so any
    // change forces a fresh import -- no stale-cache poisoning.)
    const changedEntry = textureEntry(sourceRel, 'etc1s');
    const result = await importTextureEntry(changedEntry, { cwd: tmpRoot });
    // etc1s cooks a Basis .ktx2 (needs pkg). Without pkg the import fails, but the
    // load-bearing assertion is that imageImporter.import RAN AGAIN (re-key miss).
    expect(importSpy).toHaveBeenCalledTimes(2);
    if (pkgBuilt) {
      expect('bytes' in result).toBe(true);
    }
  });

  it.skipIf(!pkgBuilt)(
    'HIT (compressionMode=auto): the expensive Basis encode is amortized on the warm build',
    async () => {
      const entry = textureEntry(sourceRel, 'auto');

      const first = await importTextureEntry(entry, { cwd: tmpRoot });
      expect('bytes' in first).toBe(true);
      if (!('bytes' in first)) return;
      // Cold build: 'auto' routed the sRGB texture through the etc1s encode.
      expect(importSpy).toHaveBeenCalledTimes(1);

      const second = await importTextureEntry(entry, { cwd: tmpRoot });
      expect('bytes' in second).toBe(true);
      if (!('bytes' in second)) return;
      // Warm build: DDC hit -- the Basis encode did NOT run again.
      expect(importSpy).toHaveBeenCalledTimes(1);
      expect(bytesEqual(second.bytes, first.bytes)).toBe(true);
      expect(second.metadata).toEqual(first.metadata);
    },
  );
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PackIndexEntry } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { importTextureEntry } from '../import-texture.js';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64',
);

const GUID = '019e3969-1d48-7c3b-ac24-6d68f457065f';

describe('importTextureEntry sidecar settings', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'forgeax-import-texture-'));
    await writeFile(join(root, 'projectile.png'), PNG);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('carries authored sRGB intent into the cooked texture metadata', async () => {
    const metaPath = join(root, 'projectile.png.meta.json');
    await writeFile(
      metaPath,
      JSON.stringify({
        importer: 'image',
        importSettings: {
          colorSpace: 'srgb',
          mipmap: 'none',
          compressionMode: 'none',
        },
      }),
    );

    const entry: PackIndexEntry = {
      guid: GUID,
      packageUrl: '/projectile.png',
      kind: 'texture',
      sourcePath: 'projectile.png',
    };
    const result = await importTextureEntry(entry, { cwd: root, metaPath });

    expect(result).toMatchObject({
      metadata: {
        format: 'rgba8unorm-srgb',
        colorSpace: 'srgb',
        mipmap: false,
        compressionMode: 'none',
      },
    });
  });
});

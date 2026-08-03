// ddc-cache.unit.test.ts -- content-addressed build DDC unit
// (tweak-20260627-model-loading-smoke-build-perf M2 / m2-1, AC-05 / AC-07).
//
// Asserts the cache's two load-bearing properties (plan-strategy D-2):
//   1. determinism: same source bytes + same import settings => same key.
//   2. content-addressing: a changed source OR changed settings => different
//      key (so a stale hit is unrepresentable -- presence == validity).
//   3. round-trip integrity: write(key, {bytes, metadata}) then read(key)
//      reconstructs the decoded bytes + metadata byte-for-byte; a fresh key
//      (never written) reads as a miss (null).

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageMetadata } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createLogicalDdcCache,
  implementationFingerprint,
  keyFor,
  read,
  resolveDdcRoot,
  semanticDdcKey,
  write,
} from '../ddc-cache.js';

const SETTINGS_A = { colorSpace: 'srgb', mipmap: true } as const;
const SETTINGS_B = { colorSpace: 'linear', mipmap: false } as const;

const META: ImageMetadata = {
  kind: 'texture',
  width: 4,
  height: 2,
  format: 'rgba8unorm-srgb',
  colorSpace: 'srgb',
  mipmap: true,
};

describe('ddc-cache.unit.test.ts', () => {
  describe('keyFor', () => {
    it('same source + same settings => identical key (determinism)', () => {
      const src = new Uint8Array([1, 2, 3, 4]);
      expect(keyFor(src, SETTINGS_A)).toBe(keyFor(new Uint8Array([1, 2, 3, 4]), SETTINGS_A));
    });

    it('settings key order does not change the key (stable serialize)', () => {
      const src = new Uint8Array([9, 9, 9]);
      const reordered = { mipmap: true, colorSpace: 'srgb' } as const;
      expect(keyFor(src, SETTINGS_A)).toBe(keyFor(src, reordered));
    });

    it('changed source => different key (content-addressed)', () => {
      const a = keyFor(new Uint8Array([1, 2, 3, 4]), SETTINGS_A);
      const b = keyFor(new Uint8Array([1, 2, 3, 5]), SETTINGS_A);
      expect(a).not.toBe(b);
    });

    it('changed import settings => different key (content-addressed)', () => {
      const src = new Uint8Array([1, 2, 3, 4]);
      expect(keyFor(src, SETTINGS_A)).not.toBe(keyFor(src, SETTINGS_B));
    });
  });

  describe('read / write round-trip', () => {
    let cwd: string;
    beforeEach(async () => {
      cwd = await mkdtemp(join(tmpdir(), 'forgeax-ddc-test-'));
    });
    afterEach(async () => {
      await rm(cwd, { recursive: true, force: true });
    });

    it('write then read reconstructs bytes + metadata byte-for-byte (hit)', async () => {
      const src = new Uint8Array([10, 20, 30, 40]);
      const key = keyFor(src, SETTINGS_A);
      const bytes = new Uint8Array([255, 0, 128, 64, 1, 2, 3, 4]);
      await write(cwd, key, { bytes, metadata: META });

      const hit = await read(cwd, key);
      if (hit === null) throw new Error('expected a cache hit');
      expect(Array.from(hit.bytes)).toEqual(Array.from(bytes));
      expect(hit.metadata).toEqual(META);
    });

    it('reading a never-written key is a miss (null)', async () => {
      const key = keyFor(new Uint8Array([7, 7, 7]), SETTINGS_A);
      await expect(read(cwd, key)).resolves.toBeNull();
    });

    it('a changed source produces a different key that misses (no stale hit)', async () => {
      const oldSrc = new Uint8Array([1, 1, 1]);
      const oldKey = keyFor(oldSrc, SETTINGS_A);
      await write(cwd, oldKey, { bytes: new Uint8Array([42]), metadata: META });

      const newKey = keyFor(new Uint8Array([1, 1, 2]), SETTINGS_A);
      expect(newKey).not.toBe(oldKey);
      await expect(read(cwd, newKey)).resolves.toBeNull();
    });
  });

  describe('semantic key', () => {
    it('does not change when only the publishing environment changes', () => {
      const semantic = {
        schemaVersion: '2.0.0',
        importerVersion: 'importer@1',
        codecVersion: 'codec@1',
        sourceDependencies: [{ path: 'a.png', digest: 'a' }],
        settings: { mipmap: true },
        declaredGuids: ['g1'],
        cookProfile: 'dev',
        publish: { base: '/', path: 'assets/a.bin', hash: 'one' },
      };
      expect(semanticDdcKey(semantic)).toBe(
        semanticDdcKey({
          ...semantic,
          publish: { base: '/preview/', path: 'assets/a-other.bin', hash: 'two' },
        }),
      );
    });

    it('changes when a semantic dependency changes', () => {
      const semantic = {
        schemaVersion: '2.0.0',
        importerVersion: 'importer@1',
        codecVersion: 'codec@1',
        sourceDependencies: [{ path: 'a.png', digest: 'a' }],
        settings: { mipmap: true },
        declaredGuids: ['g1'],
        cookProfile: 'dev',
      };
      expect(semanticDdcKey(semantic)).not.toBe(
        semanticDdcKey({
          ...semantic,
          sourceDependencies: [{ path: 'a.png', digest: 'b' }],
        }),
      );
    });
  });

  it('logical cache derives one semantic key and round-trips the package body', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgeax-logical-ddc-'));
    try {
      const input = {
        schemaVersion: '2.0.0',
        importerVersion: 'importer@1',
        codecVersion: 'codec@1',
        sourceDependencies: ['scene.json'],
        settings: { profile: 'dev' },
        declaredGuids: ['g1'],
        cookProfile: 'dev',
      } as const;
      const logicalPackage = {
        schemaVersion: '2.0.0' as const,
        kind: 'internal-text-package' as const,
        assets: [
          {
            guid: 'g1',
            kind: 'scene',
            payload: { title: 'demo' },
            refs: [],
            artifacts: {},
          },
        ],
      };
      const cache = createLogicalDdcCache(cwd);
      await expect(cache.read(input)).resolves.toBeNull();
      await cache.write(input, logicalPackage);
      expect(cache.key(input)).toBe(semanticDdcKey(input));
      await expect(cache.read(input)).resolves.toEqual(logicalPackage);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('logical cache hits after an author file moves with identical source bytes', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgeax-logical-ddc-move-'));
    try {
      const first = {
        schemaVersion: '2.0.0',
        importerVersion: 'importer@1',
        codecVersion: 'codec@1',
        sourceDependencies: [{ path: 'assets/old.scene', digest: 'source-digest' }],
        settings: { profile: 'dev' },
        declaredGuids: ['g1'],
        cookProfile: 'dev',
      } as const;
      const moved = {
        ...first,
        sourceDependencies: [{ path: 'assets/moved.scene', digest: 'source-digest' }],
      } as const;
      const logicalPackage = {
        schemaVersion: '2.0.0' as const,
        kind: 'internal-text-package' as const,
        assets: [{ guid: 'g1', kind: 'scene', payload: {}, refs: [], artifacts: {} }],
      };
      const cache = createLogicalDdcCache(cwd);
      await cache.write(first, logicalPackage);
      expect(cache.key(moved)).toBe(cache.key(first));
      await expect(cache.read(moved)).resolves.toEqual(logicalPackage);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('degrades an unavailable cache directory to a cold miss', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'forgeax-logical-ddc-io-'));
    try {
      await writeFile(join(cwd, 'node_modules'), 'not a directory');
      const cache = createLogicalDdcCache(cwd);
      await expect(
        cache.read({
          schemaVersion: '2.0.0',
          importerVersion: 'importer@1',
          codecVersion: 'codec@1',
          sourceDependencies: ['scene.json'],
          settings: {},
          declaredGuids: ['g1'],
          cookProfile: 'dev',
        }),
      ).resolves.toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it('resolves nested app builds to the nearest workspace DDC root', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'forgeax-workspace-'));
    try {
      const app = join(workspace, 'apps', 'demo');
      await mkdir(app, { recursive: true });
      await writeFile(join(workspace, 'pnpm-workspace.yaml'), 'packages: []\n');
      expect(resolveDdcRoot(app)).toBe(join(workspace, 'node_modules/.cache/forgeax-ddc'));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it('fingerprints implementation bytes without a manually bumped version', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forgeax-fingerprint-'));
    const file = join(directory, 'implementation.mjs');
    try {
      await writeFile(file, 'export const version = 1;');
      const first = implementationFingerprint([file]);
      await writeFile(file, 'export const version = 2;');
      expect(implementationFingerprint([file])).not.toBe(first);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

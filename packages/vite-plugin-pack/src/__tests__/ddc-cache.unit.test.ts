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

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageMetadata } from '@forgeax/engine-types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyFor, read, write } from '../ddc-cache.js';

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

    it('write then read reconstructs bytes + metadata byte-for-byte (hit)', () => {
      const src = new Uint8Array([10, 20, 30, 40]);
      const key = keyFor(src, SETTINGS_A);
      const bytes = new Uint8Array([255, 0, 128, 64, 1, 2, 3, 4]);
      write(cwd, key, { bytes, metadata: META });

      const hit = read(cwd, key);
      if (hit === null) throw new Error('expected a cache hit');
      expect(Array.from(hit.bytes)).toEqual(Array.from(bytes));
      expect(hit.metadata).toEqual(META);
    });

    it('reading a never-written key is a miss (null)', () => {
      const key = keyFor(new Uint8Array([7, 7, 7]), SETTINGS_A);
      expect(read(cwd, key)).toBeNull();
    });

    it('a changed source produces a different key that misses (no stale hit)', () => {
      const oldSrc = new Uint8Array([1, 1, 1]);
      const oldKey = keyFor(oldSrc, SETTINGS_A);
      write(cwd, oldKey, { bytes: new Uint8Array([42]), metadata: META });

      const newKey = keyFor(new Uint8Array([1, 1, 2]), SETTINGS_A);
      expect(newKey).not.toBe(oldKey);
      expect(read(cwd, newKey)).toBeNull();
    });
  });
});

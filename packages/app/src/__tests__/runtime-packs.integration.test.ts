import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it.each([
  'js',
  'ts',
])('installs new %s plugin assets against real native module identities and independent Cordis Fibers', async (language) => {
  // Native dynamic import must share one native ESM realm, rather than mix Vitest's module cache with Node's.
  const directory = await mkdtemp(join(tmpdir(), 'runtime-pack-recovery-'));
  try {
    const args = [
      fileURLToPath(new URL('./fixtures/runtime-packs.mjs', import.meta.url)),
      language,
      join(directory, 'source.json'),
    ];
    for (const mode of [[], ['restore']]) {
      const result = await promisify(execFile)(process.execPath, [...args, ...mode], {
        timeout: 10000,
      });
      expect(JSON.parse(result.stdout.trim())).toEqual({
        sameToken: true,
        entities: 1,
        activeAfterDispose: 0,
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 25_000);

it.each([
  'js',
  'ts',
])('consumes inherited %s Mesh and Scene in independent Worlds and restores the anchor in a fresh process', async (language) => {
  const directory = await mkdtemp(join(tmpdir(), 'runtime-pack-scene-recovery-'));
  try {
    const args = [
      fileURLToPath(new URL('./fixtures/runtime-pack-scenes.mjs', import.meta.url)),
      language,
      join(directory, 'scene.json'),
    ];
    for (const mode of [[], ['restore']]) {
      const result = await promisify(execFile)(process.execPath, [...args, ...mode], {
        timeout: 15000,
      });
      expect(JSON.parse(result.stdout.trim())).toEqual({
        independentConsumers: true,
        inheritedAnchor: true,
        recovered: mode.length > 0,
        sharedRefsAfterClose: 0,
      });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 35_000);

// @perf-budget-skip: intentional ScriptablePack CLI integration gate.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCliAsset } from '../cli-asset.js';

describe('ScriptablePack CLI Meta inspection', () => {
  it('loads the definition without invoking build', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-scriptable-pack-'));
    try {
      const source = join(root, 'house.pack.mjs');
      await writeFile(
        source,
        `
        const guid = (hex) => new Uint8Array(hex.match(/../g).map((byte) => Number.parseInt(byte, 16)));
        export default {
          schemaVersion: '1.0.0',
          packageId: guid('019ffa978b397ad284cc273268591ab4'),
          assets: {
            wall: { guid: guid('019ffa97a5ee7645b613043323952808'), kind: 'mesh' }
          },
          externalAssets: {},
          build() { throw new Error('META_MUST_NOT_BUILD'); }
        };
      `,
      );
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await runCliAsset(['meta', source, '--json'], {
        stdoutWrite: (line) => stdout.push(line),
        stderrWrite: (line) => stderr.push(line),
        cwd: root,
      });
      expect(code).toBe(0);
      expect(stderr).toEqual([]);
      expect(JSON.parse(stdout[0] ?? '{}')).toMatchObject({
        importer: 'pack-ts',
        source,
        subAssets: [{ sourceKey: 'wall', kind: 'mesh' }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

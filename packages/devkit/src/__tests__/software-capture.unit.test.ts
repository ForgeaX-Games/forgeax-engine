import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { softwareCaptureCommand } from '../software-capture.js';

describe('softwareCaptureCommand', () => {
  it('fails closed with actionable browser setup evidence', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-software-capture-'));
    await Promise.all([
      writeFile(
        resolve(root, 'forge.json'),
        `${JSON.stringify({
          id: 'capture-fixture',
          name: 'Capture Fixture',
          schemaVersion: '1.0.0',
          entry: 'main.ts',
          plugins: [],
        })}\n`,
      ),
      writeFile(
        resolve(root, 'package.json'),
        `${JSON.stringify({ name: 'capture-fixture', forgeax: { assets: { roots: [] } } })}\n`,
      ),
      writeFile(resolve(root, 'main.ts'), 'export default {};\n'),
    ]);
    const result = await softwareCaptureCommand({
      root,
      software: true,
      browser: resolve(root, 'missing-chrome-beta'),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: 'software-capture-browser-missing',
        detail: { browser: resolve(root, 'missing-chrome-beta') },
      });
    }
  });
});

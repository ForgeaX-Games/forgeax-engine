import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadSharedPackInput } from '../shared-build-inputs.js';

const here = dirname(fileURLToPath(import.meta.url));
const buildSourcePath = join(here, '..', 'build', 'plugin-build.ts');

describe('shared-inputs catalog-only contract', () => {
  it('emits the catalog before the full import arm', async () => {
    const source = await readFile(buildSourcePath, 'utf8');
    expect(source).toMatch(/FORGEAX_SHARED_APP_INPUTS_MODE === ['"]catalog-only['"]/);
    expect(source).toMatch(/projectSharedPackCatalog\(entries, opts\.base\)/);
    expect(source).toMatch(/assets\/\$\{entry\.guid\.toLowerCase\(\)\}\.bin/);
    expect(source.indexOf("'catalog-only'")).toBeLessThan(source.indexOf('// Import step'));
  });

  it('allows a schema-v2 shader-only producer without claiming an asset catalog', async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'forgeax-shader-only-'));
    try {
      const output = join(root, 'shared-build-inputs');
      await mkdir(join(output, 'shaders'), { recursive: true });
      await writeFile(
        join(output, 'shaders', 'manifest.json'),
        '{"entries":[],"materialShaders":[]}',
      );
      await writeFile(
        join(output, 'manifest.json'),
        JSON.stringify({
          schemaVersion: 2,
          producer: 'repo-build-inputs',
          inputFingerprint: 'sha256:test',
          payload: { engineShaderManifest: 'shared-build-inputs/shaders/manifest.json' },
          inventory: ['shared-build-inputs/shaders/manifest.json'],
        }),
      );
      expect(loadSharedPackInput(join(output, 'manifest.json'))).toMatchObject({
        catalog: undefined,
        payloadRoot: undefined,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

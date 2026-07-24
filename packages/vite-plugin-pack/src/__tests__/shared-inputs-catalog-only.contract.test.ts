import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('shared-inputs catalog-only contract', () => {
  it('emits the catalog before the full import arm', async () => {
    const source = await readFile(join(here, '..', 'index.ts'), 'utf8');
    expect(source).toMatch(/FORGEAX_SHARED_APP_INPUTS_MODE === ['"]catalog-only['"]/);
    expect(source).toMatch(/projectSharedPackCatalog\(entries, opts\.base\)/);
    expect(source).toMatch(/assets\/\$\{entry\.guid\.toLowerCase\(\)\}\.bin/);
    expect(source.indexOf("'catalog-only'")).toBeLessThan(source.indexOf('// Import step'));
  });
});

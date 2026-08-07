import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compileShader } from '../src/index.js';

const compilerSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const materialCookSource = readFileSync(new URL('../src/material/cook.ts', import.meta.url), 'utf8');
const vitePluginSource = readFileSync(
  new URL('../../vite-plugin-shader/src/index.ts', import.meta.url),
  'utf8',
);

describe('shader pragma owner', () => {
  it('normalizes entry pragmas at the compiler boundary', async () => {
    const result = await compileShader(
      '#pragma variant_axis STORAGE_BUFFER_AVAILABLE\n@compute @workgroup_size(1) fn main() {}',
      { id: 'test::pragma-owner' },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.wgsl).not.toContain('#pragma');
    expect(compilerSource.match(/const PRAGMA_RE =/g)).toHaveLength(1);
    expect(materialCookSource).not.toMatch(/const PRAGMA_RE =/);
    expect(materialCookSource).not.toMatch(/\.replace\(PRAGMA_RE/);
    expect(vitePluginSource).not.toMatch(/const PRAGMA_RE =/);
    expect(vitePluginSource).not.toMatch(/function stripPragmas/);
  });
});

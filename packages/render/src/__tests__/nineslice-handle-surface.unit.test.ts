import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const frameSource = readFileSync(new URL('../record/frame.ts', import.meta.url), 'utf8');
const materialSource = readFileSync(
  new URL('../record/main-pass-material.ts', import.meta.url),
  'utf8',
);

describe('9-slice handle ownership', () => {
  it('derives the lookup key from the canonical asset-runtime handle', () => {
    expect(frameSource).toContain('handleSlot(HANDLE_NINESLICE_QUAD)');
    expect(frameSource).toContain('r.assetHandle > handleSlot(HANDLE_NINESLICE_QUAD)');
    expect(frameSource).not.toMatch(/BUILTIN_MESH_ID_MAX/);
    expect(materialSource).not.toMatch(/NINESLICE_QUAD_RAW_ID\s*=/);
    expect(materialSource).not.toMatch(/BUILTIN_MESH_ID_MAX\s*=/);
  });
});

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  captureSiblingIntegration,
  PHYSICAL_MATERIAL_SIBLING_INTEGRATION,
} from '../physical-material-sibling-integration.mjs';

describe('physical material owner cut', () => {
  it('keeps SurfaceData base-only after the imported sibling cut', () => {
    const source = readFileSync('packages/shader/src/surface_v1.wgsl', 'utf8');
    expect(source).toContain('#define_import_path forgeax_material::surface_v1');
    expect(source).not.toMatch(/\bclearcoat(?:Roughness)?\b/);
  });

  it('keeps the default Standard ABI free of legacy clearcoat readers', () => {
    for (const path of [
      'packages/shader/src/default-standard-pbr.wgsl',
      'packages/shader/src/default-standard-pbr-skin.wgsl',
    ]) {
      const source = readFileSync(path, 'utf8');
      expect(source).not.toMatch(/\bclearcoat(?:Roughness)?\b/);
    }
  });

  it('retains the sibling identity as the sole re-entry input', () => {
    expect(PHYSICAL_MATERIAL_SIBLING_INTEGRATION.siblingHead).toMatch(/^[0-9a-f]{40}$/);
    expect(PHYSICAL_MATERIAL_SIBLING_INTEGRATION.surfaceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const run = (program, args) => {
      if (args.includes('rev-parse'))
        return `${PHYSICAL_MATERIAL_SIBLING_INTEGRATION.siblingHead}\n`;
      if (args.includes('status')) return '';
      if (args.some((arg) => arg.includes('surface_v1.wgsl'))) return 'sibling-source';
      throw new Error(`unexpected git invocation: ${program} ${args.join(' ')}`);
    };
    const captured = captureSiblingIntegration(
      PHYSICAL_MATERIAL_SIBLING_INTEGRATION.siblingWorktree,
      run,
    );
    expect(captured.siblingHead).toBe(PHYSICAL_MATERIAL_SIBLING_INTEGRATION.siblingHead);
    expect(captured.sourceClosure).toHaveLength(1);
  });
});

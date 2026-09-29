import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  captureSiblingIntegration,
  PHYSICAL_MATERIAL_SIBLING_INTEGRATION,
} from '../physical-material-sibling-integration.mjs';

describe('physical material sibling integration gate', () => {
  it('keeps the sibling commit identity and source closure auditable', () => {
    const surface = readFileSync('packages/shader/src/surface_v1.wgsl');
    const run = (program, args, _options) => {
      if (program !== 'git') throw new Error(`unexpected program: ${program}`);
      if (args.includes('rev-parse'))
        return `${PHYSICAL_MATERIAL_SIBLING_INTEGRATION.siblingHead}\n`;
      if (args.includes('status'))
        return ' M packages/render/src/__tests__/surface-standard-pipeline.browser.test.ts\n';
      if (args.some((arg) => arg.includes('surface_v1.wgsl'))) return surface;
      throw new Error(`unexpected git invocation: ${args.join(' ')}`);
    };
    const captured = captureSiblingIntegration(
      PHYSICAL_MATERIAL_SIBLING_INTEGRATION.siblingWorktree,
      run,
    );

    expect(captured.siblingHead).toBe(PHYSICAL_MATERIAL_SIBLING_INTEGRATION.siblingHead);
    expect(captured.dirty).toBe(true);
    expect(captured.liveStep).toBe('requirements');
    expect(captured.sourceClosure[0]?.path).toBe(PHYSICAL_MATERIAL_SIBLING_INTEGRATION.surfacePath);
    expect(captured.sourceClosure[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('requires the imported Surface path before the owner cut', () => {
    expect(readFileSync('packages/shader/src/surface_v1.wgsl', 'utf8')).toContain(
      '#define_import_path forgeax_material::surface_v1',
    );
  });
});

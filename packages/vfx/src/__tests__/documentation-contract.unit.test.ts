import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..', '..');
const repoRoot = resolve(packageRoot, '..', '..');
const vfxReadme = readFileSync(resolve(packageRoot, 'README.md'), 'utf8');
const compilerReadme = readFileSync(
  resolve(packageRoot, '..', 'vfx-compiler', 'README.md'),
  'utf8',
);
const typesReadme = readFileSync(resolve(packageRoot, '..', 'types', 'README.md'), 'utf8');
const handoff = readFileSync(resolve(repoRoot, 'docs/vfx-particle-runtime-design.md'), 'utf8');
const assetsSkill = readFileSync(
  resolve(repoRoot, 'skills/forgeax-engine-assets/SKILL.md'),
  'utf8',
);

describe('VFX documentation contract', () => {
  it('keeps the public simulation path searchable at the package entry', () => {
    for (const term of [
      'particle simulation',
      'ParticleEffectPlayer',
      'ParticleRenderBatch',
      'CPU-only',
      'FixedUpdate',
      'runPlugins(world, defaultSet, userPlugins)',
    ]) {
      expect(vfxReadme.toLowerCase()).toContain(term.toLowerCase());
    }
    expect(vfxReadme).toContain('The text contract is sufficient without reading the diagram.');
    expect(vfxReadme).toContain('Structured recovery');
  });

  it('documents lifecycle, backend, readiness, and batch ownership as text', () => {
    for (const term of [
      'lifecycle',
      'backend',
      'readiness',
      'AssetRegistry',
      'World shared handle',
      'batch ownership',
      'Rendering boundary',
      'empty',
      'disabled',
      'unavailable',
    ]) {
      expect(vfxReadme.toLowerCase()).toContain(term.toLowerCase());
    }
    expect(vfxReadme).toMatch(/\|\s*State\s*\|[\s\S]*\|\s*empty\s*\|/i);
    expect(vfxReadme).toMatch(/\|\s*State\s*\|[\s\S]*\|\s*disabled\s*\|/i);
    expect(vfxReadme).toMatch(/\|\s*State\s*\|[\s\S]*\|\s*unavailable\s*\|/i);
  });

  it('retains compiler/runtime isolation evidence and navigable handoff links', () => {
    expect(compilerReadme).toContain('must never be imported by a player bundle');
    expect(compilerReadme).toContain('runtime dependency graphs');
    expect(typesReadme).toContain('ParticleEffectAsset');
    expect(handoff).toContain('Wave 1 Gate');
    expect(assetsSkill).toContain('loadByGuid');

    for (const target of [
      'packages/vfx/README.md',
      'packages/vfx-compiler/README.md',
      'packages/types/README.md',
      'docs/vfx-particle-runtime-design.md',
      'skills/forgeax-engine-assets/SKILL.md',
    ]) {
      expect(existsSync(resolve(repoRoot, target)), target).toBe(true);
    }
  });
});

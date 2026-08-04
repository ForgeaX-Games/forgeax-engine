import { readFileSync } from 'node:fs';
import { createProfiler } from '@forgeax/engine-profiler';
import { describe, expect, it } from 'vitest';

import { RENDER_PHASE_CATALOG } from '../renderer';

describe('Render profiler phase catalog ownership', () => {
  it('matches the profiler receiver set by definition and has five unique phases', () => {
    const profiler = createProfiler();
    expect(profiler.registerPhaseCatalog('render', RENDER_PHASE_CATALOG).ok).toBe(true);
    expect(RENDER_PHASE_CATALOG).toHaveLength(5);
    expect(new Set(RENDER_PHASE_CATALOG).size).toBe(RENDER_PHASE_CATALOG.length);
    expect(new Set(RENDER_PHASE_CATALOG)).toEqual(new Set(profiler.phaseCatalog.render));
  });

  it('rejects a second Render catalog definition', () => {
    const profiler = createProfiler();
    expect(profiler.registerPhaseCatalog('render', RENDER_PHASE_CATALOG).ok).toBe(true);
    const duplicate = profiler.registerPhaseCatalog('render', RENDER_PHASE_CATALOG);
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error.code).toBe('phase-catalog-conflict');
  });

  it('keeps the phase declaration in the Render owner module', () => {
    const source = readFileSync(new URL('../renderer.ts', import.meta.url), 'utf8');
    expect(source).toContain('RENDER_PHASE_CATALOG');
    expect(source).not.toContain('RenderPhaseObserver');
    expect(source).not.toContain('renderFrameSeq');
  });
});

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDawnErrors, READINESS_FRAME_LIMIT } from '../../scripts/smoke-diagnostics.mjs';

const smokePath = resolve(import.meta.dirname, '../../scripts/smoke-dawn.mjs');

describe('Boss Lightning Dawn pixel probe contract', () => {
  it('requires separate billboard and mesh zones plus the 300-frame draw probe', () => {
    const source = readFileSync(smokePath, 'utf8');
    expect(source).toContain('copyTextureToBuffer');
    expect(source).toContain('billboardZone');
    expect(source).toContain('meshZone');
    expect(source).toContain('billboard');
    expect(source).toContain('mesh');
    expect(source).toContain('TARGET_FRAMES = 300');
    expect(source).toContain('queuedIntents');
    expect(source).toContain('runtimeDiagnostics');
    expect(source).toContain('billboardEnergy');
    expect(source).toContain('meshEnergy');
    expect(source).toContain('strikeOnly');
    expect(source).toContain('readiness');
    expect(source).toContain('readinessFrameLimit');
    expect(source).toContain('persistentErrors');
    expect(source).toContain('recovery');
    expect(source).toContain('process.exit(0)');
  });

  it('keeps the depth provider and soft-particle oracle explicit', () => {
    const source = readFileSync(smokePath, 'utf8');
    expect(source).toContain('scene-depth');
    expect(source).toContain('depthProviderReady');
    expect(source).toContain('softParticle');
    expect(source).toContain('missing-depth');
  });

  it('keeps independent advanced topology oracles in the Dawn path', () => {
    const source = readFileSync(smokePath, 'utf8');
    for (const topology of ['textureSheet', 'pivot', 'softParticle', 'sorting', 'ribbon', 'trail', 'beam']) {
      expect(source).toContain(topology);
    }
    expect(source).toContain('topologyCounters');
    expect(source).toContain('indirectDraws');
  });

  it('accepts only bounded next-frame preparation warm-up before readiness', () => {
    const { warmupErrors, persistentErrors } = classifyDawnErrors(
      [
        {
          code: 'render-feature-preparation-failed',
          detail: { stage: 'prepare', recovery: 'next-frame' },
          frame: 0,
        },
        {
          code: 'render-feature-preparation-failed',
          detail: { stage: 'prepare', recovery: 'next-frame' },
          frame: READINESS_FRAME_LIMIT + 1,
        },
      ],
      1,
    );
    expect(warmupErrors).toHaveLength(1);
    expect(persistentErrors).toHaveLength(1);
  });
});

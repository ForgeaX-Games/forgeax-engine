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
    expect(source).toContain('bucketCount');
    expect(source).toContain('drawCount');
    expect(source).toContain('strikeOnly');
    expect(source).toContain('readiness');
    expect(source).toContain('readinessFrameLimit');
    expect(source).toContain('persistentErrors');
    expect(source).toContain('recovery');
    expect(source).toContain('process.exit(0)');
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

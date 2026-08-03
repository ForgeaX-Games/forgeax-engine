import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDawnErrors, READINESS_FRAME_LIMIT } from '../../scripts/smoke-diagnostics.mjs';

const appRoot = resolve(import.meta.dirname, '../..');
const dawnSource = readFileSync(resolve(appRoot, 'scripts/smoke-dawn.mjs'), 'utf8');
const browserSource = readFileSync(resolve(appRoot, 'scripts/smoke-browser.mjs'), 'utf8');
const falsifySource = readFileSync(resolve(appRoot, 'scripts/smoke-falsify.mjs'), 'utf8');

describe('Boss Lightning smoke probe contract', () => {
  it('uses particle-specific Dawn signals and rejects persistent preparation errors', () => {
    expect(dawnSource).toContain('TARGET_FRAMES = 300');
    expect(dawnSource).toContain('SEED = 42');
    expect(dawnSource).toContain('camera: CAMERA');
    expect(dawnSource).toContain('bucketCount');
    expect(dawnSource).toContain('drawCount');
    expect(dawnSource).toContain('particleCount');
    expect(dawnSource).toContain('billboardEnergy');
    expect(dawnSource).toContain('meshEnergy');
    expect(dawnSource).toContain('persistentErrors');
    expect(dawnSource).toContain('strikeOnly');
    expect(dawnSource).not.toContain('console.error = () => {}');

    const classified = classifyDawnErrors(
      [
        {
          code: 'render-feature-preparation-failed',
          detail: { stage: 'prepare', recovery: 'next-frame' },
          frame: 3,
        },
        {
          code: 'render-feature-preparation-failed',
          detail: { stage: 'prepare', recovery: 'next-frame' },
          frame: READINESS_FRAME_LIMIT + 1,
        },
      ],
      8,
    );
    expect(classified.warmupErrors).toHaveLength(1);
    expect(classified.persistentErrors).toHaveLength(1);
  });

  it('keeps Browser validation, readiness, and falsifier exits explicit', () => {
    expect(browserSource).toContain('validationErrors');
    expect(browserSource).toContain("readiness !== 'ready'");
    expect(browserSource).toContain('cameraReady');
    expect(browserSource).toContain('seed: 42');
    expect(falsifySource).toContain("'disable-billboard'");
    expect(falsifySource).toContain("'disable-vfx'");
    expect(falsifySource).toContain("'emitter-zero'");
    expect(falsifySource).toContain("'material-empty'");
    expect(falsifySource).toContain('result.status === 0');
  });
});

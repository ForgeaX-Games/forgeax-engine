import { describe, expect, it } from 'vitest';
import { resolveStandardRenderFeatureTargets } from '../features/targets';

function targets(
  tonemap: 'none' | 'aces-filmic',
  antialias: 'none' | 'fxaa' | 'msaa',
  storageBuffer: boolean,
) {
  return resolveStandardRenderFeatureTargets({
    tonemap,
    antialias,
    colorAttachmentFormat: 'bgra8unorm-srgb',
    storageBuffer,
    multisample: true,
  });
}

describe('urp render feature targets', () => {
  it('publishes the linear-LDR target used by native no-tonemap frames', () => {
    expect(targets('none', 'none', true)?.[0]).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 1,
    });
  });

  it('publishes the MSAA linear-LDR target with the graph sample count', () => {
    expect(targets('none', 'msaa', true)?.[0]).toMatchObject({
      kind: 'scene-color',
      format: 'rgba16float',
      sampleCount: 4,
    });
  });

  it('keeps the surface target for non-storage-buffer LDR frames', () => {
    expect(targets('none', 'none', false)?.[0]).toMatchObject({
      kind: 'scene-color',
      format: 'bgra8unorm-srgb',
      sampleCount: 1,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { urpPipeline } from '../urp-pipeline';

function targets(
  tonemap: 'none' | 'aces-filmic',
  antialias: 'none' | 'fxaa' | 'msaa',
  storageBuffer: boolean,
) {
  return urpPipeline.getRenderFeatureTargets?.({
    camera: { tonemap, antialias },
    colorAttachmentFormat: 'bgra8unorm-srgb',
    backendKind: 'wgpu-native',
    storageBuffer,
  });
}

describe('urp render feature targets', () => {
  it('publishes the linear-LDR target used by native no-tonemap frames', () => {
    expect(targets('none', 'none', true)?.[0]).toMatchObject({
      resource: 'ldrColor',
      format: 'rgba16float',
      sampleCount: 1,
    });
  });

  it('publishes the MSAA linear-LDR target with the graph sample count', () => {
    expect(targets('none', 'msaa', true)?.[0]).toMatchObject({
      resource: 'msaaColor',
      format: 'rgba16float',
      sampleCount: 4,
    });
  });

  it('keeps the surface target for non-storage-buffer LDR frames', () => {
    expect(targets('none', 'none', false)?.[0]).toMatchObject({
      resource: 'swapchain',
      format: 'bgra8unorm-srgb',
      sampleCount: 1,
    });
  });
});

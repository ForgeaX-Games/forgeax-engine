import { describe, expect, it } from 'vitest';
import { RenderTargetCapabilityMissingError } from '../errors/render';
import {
  admitRenderTargetDescriptor,
  type RenderTargetAdmissionLimits,
  type RenderTargetDescriptor,
} from '../targets/contracts';

const limits: RenderTargetAdmissionLimits = {
  maxTextureDimension2D: 4096,
  maxBytesPerTarget: 64 * 1024 * 1024,
  renderableFormats: ['rgba16float', 'rgba8unorm', 'rgba8unorm-srgb'],
  sampleCounts: [1, 4],
  depthFormats: ['depth24plus-stencil8', 'depth32float'],
};

const base: RenderTargetDescriptor = {
  shape: '2d',
  width: 512,
  height: 256,
  format: 'rgba8unorm',
  mipLevels: 1,
  sampleCount: 1,
  sampled: true,
  readback: true,
};

describe('RenderTarget descriptor admission', () => {
  it('accepts the complete first-version descriptor vocabulary', () => {
    const result = admitRenderTargetDescriptor(base, limits);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['zero width', { width: 0 }],
    ['zero height', { height: 0 }],
    ['non-square cube', { shape: 'cube' as const }],
  ])('rejects %s before allocation', (_name, patch) => {
    const descriptor = { ...base, ...patch };
    if ('shape' in patch && patch.shape === 'cube') descriptor.height = 256;
    const result = admitRenderTargetDescriptor(descriptor, limits);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('render-target-descriptor-invalid');
  });

  it('rejects unsupported format, sample count, and byte budget', () => {
    const formatResult = admitRenderTargetDescriptor(
      { ...base, format: 'rgba16float' },
      { ...limits, renderableFormats: ['rgba8unorm'] },
    );
    expect(formatResult.ok).toBe(false);
    if (!formatResult.ok) expect(formatResult.error.code).toBe('render-target-capability-missing');

    const sampleResult = admitRenderTargetDescriptor(
      { ...base, sampleCount: 4 },
      { ...limits, sampleCounts: [1] },
    );
    expect(sampleResult.ok).toBe(false);
    if (!sampleResult.ok) expect(sampleResult.error.code).toBe('render-target-capability-missing');

    const bytesResult = admitRenderTargetDescriptor(
      { ...base, width: 2048, height: 2048, mipLevels: 'full' },
      { ...limits, maxBytesPerTarget: 1024 },
    );
    expect(bytesResult.ok).toBe(false);
    if (!bytesResult.ok) expect(bytesResult.error.code).toBe('render-target-descriptor-invalid');
  });

  it('does not reinterpret format or silently fall back on depth', () => {
    const result = admitRenderTargetDescriptor(
      { ...base, depth: 'depth32float' },
      { ...limits, depthFormats: ['depth24plus-stencil8'] },
    );
    expect(result.ok).toBe(false);
    if (!result.ok && result.error instanceof RenderTargetCapabilityMissingError) {
      expect(result.error.code).toBe('render-target-capability-missing');
      expect(result.error.detail.requested).toBe('depth32float');
    }
  });
});

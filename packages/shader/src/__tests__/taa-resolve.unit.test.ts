import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../taa-resolve.wgsl'), 'utf8');

describe('taa-resolve.wgsl', () => {
  it('keeps the fixed packed temporal and two-attachment ABI', () => {
    expect(source).toContain('struct TaaResolveParams');
    expect(source).toContain('@location(0) color');
    expect(source).toContain('@location(1) temporal');
    expect(source).toContain('output.temporal = temporal');
    expect(source).toContain('current.a');
  });

  it('contains every v1 rejection and adaptive weighting term', () => {
    expect(source).toContain('uv + params.currentJitterUv');
    expect(source).toContain('in.uv - temporal.xy');
    expect(source).toContain('closestCurrentTemporal(pixel, dimensions)');
    expect(source).toContain('historyInBounds');
    expect(source).toContain('depthDelta > depthThreshold');
    expect(source).toContain('neighborhoodSquareMean');
    expect(source).toContain('clamp(rgbToYCoCg(sampledHistory.rgb), clipMin, clipMax)');
    expect(source).toContain('reactiveFactor');
    expect(source).toContain('velocityFactor');
    expect(source).toContain('depthFactor');
    expect(source).toContain('lumaFactor');
    expect(source).toContain('mix(0.88, 0.97, lumaFactor)');
    expect(source).toContain('params.temporalFrameIndex < 8u');
    expect(source).toContain('progressiveWeight');
  });
});

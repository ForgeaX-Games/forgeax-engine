// texture-status.unit.test.ts — unit tests for per-texture degradation matrix.
//
// Tests computeTextureStatus: pure function that maps a set of texture
// attachment descriptors to per-texture status values.
//
// Status values: ok | no-rt | no-webgpu | error
//
// AC-18: per-texture status matrix, single texture failure does not contaminate
// other textures (isolation guarantee).
//
// Related: plan-strategy D-4; research Finding 9/12; requirements AC-18.
// w16 (test, red phase — computeTextureStatus module created in w17).

import { describe, expect, it } from 'vitest';
import { computeTextureStatus } from '../texture-status';

// ============================================================================
// AC-18: single texture error does not contaminate others (isolation)
// ============================================================================

describe('computeTextureStatus — isolation (AC-18)', () => {
  it('marks depth24plus-stencil8 as error while other textures remain ok', () => {
    const result = computeTextureStatus([
      { handleId: 'tex_depth', format: 'depth24plus-stencil8' },
      { handleId: 'tex_color0', format: 'rgba8unorm' },
      { handleId: 'tex_color1', format: 'bgra8unorm' },
    ]);

    expect(result[0]?.status).toBe('error');
    expect(result[1]?.status).toBe('ok');
    expect(result[2]?.status).toBe('ok');
  });

  it('marks depth24plus as error while depth32float is ok', () => {
    const result = computeTextureStatus([
      { handleId: 'tex_depth_hdr', format: 'depth32float' },
      { handleId: 'tex_depth_urp', format: 'depth24plus-stencil8' },
      { handleId: 'tex_color', format: 'rgba8unorm' },
    ]);

    expect(result[0]?.status).toBe('ok');
    expect(result[1]?.status).toBe('error');
    expect(result[2]?.status).toBe('ok');
  });

  it('marks all as error when no WebGPU available', () => {
    const result = computeTextureStatus(
      [
        { handleId: 'tex_a', format: 'rgba8unorm' },
        { handleId: 'tex_b', format: 'depth32float' },
      ],
      false, // webgpuAvailable
    );

    for (const entry of result) {
      expect(entry.status).toBe('no-webgpu');
    }
  });
});

// ============================================================================
// AC-18: empty textures list = no-rt
// ============================================================================

describe('computeTextureStatus — no-rt', () => {
  it('returns empty array (no-rt implied) when no textures provided', () => {
    const result = computeTextureStatus([]);
    expect(result).toHaveLength(0);
  });
});

// ============================================================================
// All four status variants
// ============================================================================

describe('computeTextureStatus — all variants', () => {
  it('returns ok for typical color textures', () => {
    const result = computeTextureStatus([
      { handleId: 'tex_color0', format: 'rgba8unorm' },
      { handleId: 'tex_depth', format: 'depth32float' },
    ]);

    for (const entry of result) {
      expect(entry.status).toBe('ok');
    }
  });

  it('returns error for depth24plus and depth24plus-stencil8', () => {
    const result = computeTextureStatus([
      { handleId: 'd0', format: 'depth24plus' },
      { handleId: 'd1', format: 'depth24plus-stencil8' },
    ]);

    expect(result[0]?.status).toBe('error');
    expect(result[1]?.status).toBe('error');
  });

  it('returns no-webgpu for all textures when webgpuAvailable is false', () => {
    const result = computeTextureStatus(
      [
        { handleId: 'tex_a', format: 'rgba8unorm' },
        { handleId: 'tex_b', format: 'depth32float' },
        { handleId: 'tex_c', format: 'depth24plus-stencil8' },
      ],
      false,
    );

    expect(result).toHaveLength(3);
    for (const entry of result) {
      expect(entry.status).toBe('no-webgpu');
    }
  });

  it('distinguishes between no-webgpu and error (no-webgpu takes precedence)', () => {
    // When both conditions apply, no-webgpu is the more fundamental status.
    const result = computeTextureStatus(
      [{ handleId: 'tex_depth', format: 'depth24plus-stencil8' }],
      false,
    );

    expect(result[0]?.status).toBe('no-webgpu');
  });
});

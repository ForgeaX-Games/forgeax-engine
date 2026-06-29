import { KNOWN_PASS_KINDS, type PassKind, type VertexAttributeMap } from '@forgeax/engine-types';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { cacheKeyOf, type PipelineSpec } from '../pipeline-spec';

/*
 * feat-20260615-pipeline-spec-ssot M2-T2: cache key axis tests migrated from
 * materialShaderPipelineCacheKey to cacheKeyOf(spec).
 *
 * Post-migration: cacheKeyOf covers all 4 PipelineSpec axes (shader /
 * attachments / geometry / renderState). The old 8-segment string construction
 * is deleted. These tests verify equivalent cache-key semantics.
 */

const DEFAULT_VERTEX_LAYOUT: VertexAttributeMap = {
  position: new Float32Array(0),
  normal: new Float32Array(0),
  uv: new Float32Array(0),
  tangent: new Float32Array(0),
};

function specOf(
  id: string,
  isHdr: boolean,
  passKind: string = 'forward',
  topology = 'triangle-list' as const,
  variantSet?: string,
  sampleCount: 1 | 4 = 1,
): PipelineSpec {
  const colorFormat: GPUTextureFormat = isHdr
    ? ('rgba16float' as unknown as GPUTextureFormat)
    : ('bgra8unorm-srgb' as unknown as GPUTextureFormat);
  const depthFormat: GPUTextureFormat =
    passKind === 'shadow-caster'
      ? ('depth32float' as unknown as GPUTextureFormat)
      : ('depth24plus-stencil8' as unknown as GPUTextureFormat);

  return {
    shader: { id, passKind, variantSet },
    attachments: {
      colorFormats: passKind === 'shadow-caster' ? [] : [colorFormat],
      depthFormat,
      sampleCount,
    },
    geometry: {
      topology,
      vertexLayout: DEFAULT_VERTEX_LAYOUT,
    },
    renderState: undefined,
  };
}

describe('cacheKeyOf passKind dimension', () => {
  const SHADER_ID = 'forgeax::default-unlit';

  it('same shaderId + entries produce different keys for forward vs shadow-caster', () => {
    const forwardKey = cacheKeyOf(specOf(SHADER_ID, false, 'forward'));
    const shadowKey = cacheKeyOf(specOf(SHADER_ID, false, 'shadow-caster'));

    expect(forwardKey).not.toBe(shadowKey);
  });

  it('same passKind + entries produce identical keys', () => {
    const key1 = cacheKeyOf(specOf(SHADER_ID, true, 'forward'));
    const key2 = cacheKeyOf(specOf(SHADER_ID, true, 'forward'));

    expect(key1).toBe(key2);
  });

  it('default passKind is forward (backward compatibility)', () => {
    const explicitKey = cacheKeyOf(specOf(SHADER_ID, false, 'forward'));
    const defaultKey = cacheKeyOf(specOf(SHADER_ID, false));

    expect(defaultKey).toBe(explicitKey);
  });

  it('HDR variant + passKind both distinguish keys', () => {
    const ldrForward = cacheKeyOf(specOf(SHADER_ID, false, 'forward'));
    const hdrForward = cacheKeyOf(specOf(SHADER_ID, true, 'forward'));
    const ldrShadow = cacheKeyOf(specOf(SHADER_ID, false, 'shadow-caster'));

    const unique = new Set([ldrForward, hdrForward, ldrShadow]);
    expect(unique.size).toBe(3);
  });

  it('different shaderId + same passKind produce different keys', () => {
    const key1 = cacheKeyOf(specOf('forgeax::default-unlit', false, 'forward'));
    const key2 = cacheKeyOf(specOf('forgeax::default-standard-pbr', false, 'forward'));

    expect(key1).not.toBe(key2);
  });

  it('variantSet and passKind are orthogonal cache dimensions', () => {
    const urpForward = cacheKeyOf(
      specOf(
        SHADER_ID,
        false,
        'forward',
        'triangle-list',
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
      ),
    );
    const hdrpForward = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', ''));
    const urpShadow = cacheKeyOf(
      specOf(
        SHADER_ID,
        false,
        'shadow-caster',
        'triangle-list',
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
      ),
    );
    const hdrpShadow = cacheKeyOf(specOf(SHADER_ID, false, 'shadow-caster', 'triangle-list', ''));
    const unique = new Set([urpForward, hdrpForward, urpShadow, hdrpShadow]);
    expect(unique.size).toBe(4);
  });
});

/*
 * feat-20260612-hdrp-deferred-shading-learn-render-5-8 M1 / w1:
 * PassKind 4-value closed union narrow test.
 *
 * AC-03: PassKind = 'forward' | 'deferred' | 'lighting' | 'shadow-caster'.
 * The union is closed; TS exhaustive-switch without default must compile.
 * The pre-rename value 'shadow-depth-only' must NOT be a member of the union (backwards-assert).
 */
describe('PassKind open string + KNOWN_PASS_KINDS (feat-20260615 D-10)', () => {
  // M2-T4 expanded KNOWN_PASS_KINDS from 4 to 6 entries by adding 'post-process'
  // and 'skybox' so fullscreen-post + skybox passes can route through
  // SPEC_CONST_TABLE / getOrBuildPipeline rather than raw createRenderPipeline.
  it('KNOWN_PASS_KINDS has exactly 6 entries', () => {
    expect(KNOWN_PASS_KINDS).toHaveLength(6);
  });

  it('KNOWN_PASS_KINDS contains the 6 engine-shipped pass kinds', () => {
    expect(KNOWN_PASS_KINDS).toContain('forward');
    expect(KNOWN_PASS_KINDS).toContain('deferred');
    expect(KNOWN_PASS_KINDS).toContain('lighting');
    expect(KNOWN_PASS_KINDS).toContain('shadow-caster');
    expect(KNOWN_PASS_KINDS).toContain('post-process');
    expect(KNOWN_PASS_KINDS).toContain('skybox');
  });

  it('shadow-caster is a valid PassKind value', () => {
    const pk: PassKind = 'shadow-caster';
    expect(pk).toBe('shadow-caster');
  });

  it('deferred and lighting are valid PassKind values', () => {
    const pk1: PassKind = 'deferred';
    const pk2: PassKind = 'lighting';
    expect(pk1).toBe('deferred');
    expect(pk2).toBe('lighting');
  });

  it('PassKind is an open string (assignable from any string)', () => {
    expectTypeOf<PassKind>().toEqualTypeOf<string>();
  });

  it('PassKind accepts unknown custom strings', () => {
    const pk: PassKind = 'custom-user-pass';
    expect(typeof pk).toBe('string');
  });
});

/*
 * bug-20260615-msaa-silently-disables-custom-material-shaders M1 + M2 / m2-1:
 * sampleCount cache-key axis (migrated to cacheKeyOf).
 *
 * sampleCount is part of the attachments axis in PipelineSpec.
 * spec.sampleCount: 1 | 4 — distinct values produce distinct cache keys.
 */
describe('cacheKeyOf sampleCount axis', () => {
  const SHADER_ID = 'forgeax::default-unlit';

  it('sampleCount=1 produces stable key', () => {
    const key1 = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined, 1));
    const key2 = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined, 1));
    expect(key1).toBe(key2);
  });

  it('sampleCount=4 produces a key distinct from count=1 (MSAA-variant slot)', () => {
    const keyCount1 = cacheKeyOf(
      specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined, 1),
    );
    const keyCount4 = cacheKeyOf(
      specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined, 4),
    );
    expect(keyCount1).not.toBe(keyCount4);
  });

  it('sampleCount interacts correctly with existing axes (hdr + variantSet + passKind)', () => {
    const key1 = cacheKeyOf(specOf(SHADER_ID, false, 'forward', 'triangle-list', undefined, 1));
    const key2 = cacheKeyOf(specOf(SHADER_ID, true, 'forward', 'triangle-list', undefined, 1));
    const key3 = cacheKeyOf(
      specOf(
        SHADER_ID,
        false,
        'forward',
        'triangle-list',
        'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true',
        1,
      ),
    );
    const key4 = cacheKeyOf(
      specOf(SHADER_ID, false, 'shadow-caster', 'triangle-list', undefined, 1),
    );
    const unique = new Set([key1, key2, key3, key4]);
    expect(unique.size).toBe(4);
  });
});

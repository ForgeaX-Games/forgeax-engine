// hdrp-buffers.unit.test.ts -- M3-T2-TEST: byte-equiv guard for D-13 dispatcher.
//
// hdrp-buffers.ts:365 unifiedBglDesc must equal
// buildBindGroupLayoutDescriptor(spec, { kind: 'hdrp-7-slot', caps }).
// The HDRP unified BGL is 9 entries (binding 0 + 3..8) -- the historical
// "7-slot" name predates the SSAO scope-amend that pushed the count to 9
// while keeping the BglKind tag stable.

import { describe, expect, it } from 'vitest';
import {
  createHdrpBindGroupLayoutDescriptor,
  HDRP_UNIFORM_LIGHT_CAPACITY,
  packClusterUniform,
} from './hdrp-buffers';
import type { PipelineSpec } from './pipeline-spec';
import { buildBindGroupLayoutDescriptor } from './pipeline-spec';

function makeSpec(): PipelineSpec {
  return {
    shader: {
      id: 'forgeax::default-standard-pbr',
      passKind: 'forward',
      variantSet: 'CLUSTER_FORWARD_AVAILABLE=true',
    },
    attachments: {
      colorFormats: ['rgba16float'],
      depthFormat: 'depth32float',
      sampleCount: 1,
    },
    geometry: {
      topology: 'triangle-list',
      vertexLayout: {},
    },
    renderState: undefined,
  };
}

describe('buildBindGroupLayoutDescriptor — hdrp-7-slot byte-equiv', () => {
  it('packs the uniform downlevel light count into the existing cluster UBO lane', () => {
    const payload = packClusterUniform({ x: 16, y: 9, z: 24 }, 0.1, 100, 0.9, 200);
    const u32 = new Uint32Array(payload);
    expect(u32[3]).toBe(HDRP_UNIFORM_LIGHT_CAPACITY);
    expect(payload.byteLength).toBe(32);
  });

  it('storageBuffer=true: 9 entries matching createHdrpBindGroupLayoutDescriptor(true)', () => {
    const spec = makeSpec();
    const out = buildBindGroupLayoutDescriptor(spec, {
      kind: 'hdrp-7-slot',
      caps: { storageBuffer: true },
    });
    const expectedDesc = createHdrpBindGroupLayoutDescriptor(true);
    expect(out.label).toBe(expectedDesc.label);
    expect(out.entries).toEqual(expectedDesc.entries);
    expect(out.entries.length).toBe(7);
  });

  it('storageBuffer=false: cluster bindings fall back to uniform', () => {
    const spec = makeSpec();
    const out = buildBindGroupLayoutDescriptor(spec, {
      kind: 'hdrp-7-slot',
      caps: { storageBuffer: false },
    });
    const expectedDesc = createHdrpBindGroupLayoutDescriptor(false);
    expect(out.entries).toEqual(expectedDesc.entries);
    // Binding 3 (light_data) cluster-buf type follows storageBuffer caps.
    const binding3 = (out.entries as readonly GPUBindGroupLayoutEntry[]).find(
      (e) => e.binding === 3,
    );
    expect(binding3?.buffer?.type).toBe('uniform');
  });

  it('default caps (storageBuffer=true) when caps is omitted', () => {
    const spec = makeSpec();
    const out = buildBindGroupLayoutDescriptor(spec, { kind: 'hdrp-7-slot' });
    const expectedDesc = createHdrpBindGroupLayoutDescriptor(true);
    expect(out.entries).toEqual(expectedDesc.entries);
  });
});

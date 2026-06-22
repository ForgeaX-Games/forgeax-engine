// pbr-pipeline.unit.test.ts -- M3-T1-TEST: byte-equiv guard for D-13 dispatcher.
//
// For each of the 6 createBindGroupLayout sites in pbr-pipeline.ts
// (view / material-merged / mesh-array / instances / skin-mesh-array /
// unlit-material), assert that the descriptor passed to
// device.createBindGroupLayout(...) deep-equals
// buildBindGroupLayoutDescriptor(spec, { kind, caps }).
//
// This pins M3-T1's byte-equiv refactor: the 6 hand-written entries[] arrays
// must be replaced by buildBindGroupLayoutDescriptor calls without changing
// what the device sees.

import { describe, expect, it } from 'vitest';
import {
  appendInjection,
  buildPbrMaterialUserRegionEntries,
  buildPbrViewBglEntries,
} from './pbr-pipeline';
import type { PipelineSpec } from './pipeline-spec';
import { buildBindGroupLayoutDescriptor } from './pipeline-spec';

// Stable spec stub — the dispatcher uses spec.shader for reflection only when
// a registry is supplied; without registry the BGL shape comes purely from
// the kind + caps inputs.
function makeSpec(): PipelineSpec {
  return {
    shader: {
      id: 'forgeax::default-standard-pbr',
      passKind: 'forward',
      variantSet: undefined,
    },
    attachments: {
      colorFormats: ['rgba8unorm-srgb'],
      depthFormat: 'depth24plus-stencil8',
      sampleCount: 1,
    },
    geometry: {
      topology: 'triangle-list',
      vertexLayout: {},
    },
    renderState: undefined,
  };
}

describe('buildBindGroupLayoutDescriptor — pbr-pipeline 6 sites byte-equiv', () => {
  describe('pbr-view', () => {
    it('storageBuffer=true: 8 entries with read-only-storage on bindings 1+2', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-view',
        caps: { storageBuffer: true },
      });
      const expected = {
        label: 'pbr-view-bgl',
        entries: buildPbrViewBglEntries({ storageBuffer: true }),
      };
      expect(out).toEqual(expected);
      expect(out.entries.length).toBe(8);
    });

    it('storageBuffer=false: bindings 1+2 fall back to uniform', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-view',
        caps: { storageBuffer: false },
      });
      const expected = {
        label: 'pbr-view-bgl',
        entries: buildPbrViewBglEntries({ storageBuffer: false }),
      };
      expect(out).toEqual(expected);
    });
  });

  describe('pbr-material-merged', () => {
    it('18 entries: user-region 7 (derived) + ibl 7 + lightmap 4', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-material-merged',
      });
      // Post-M2 (D-1): user-region comes from derive(paramSchema).bglEntries
      // (built-in standard-PBR 3-texture fallback), then IBL + lightmap are
      // appended at start = userRegion.length.
      const userRegion = buildPbrMaterialUserRegionEntries();
      const afterIbl = [...userRegion, ...appendInjection(userRegion, 'ibl')];
      const expected = {
        label: 'pbr-material-skylight-bgl',
        entries: [...afterIbl, ...appendInjection(afterIbl, 'lightmap')],
      };
      expect(out).toEqual(expected);
      expect(out.entries.length).toBe(18);
    });
  });

  describe('pbr-mesh-array', () => {
    it('storageBuffer=true: 1 entry with read-only-storage + dynamic offset', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-mesh-array',
        caps: { storageBuffer: true },
      });
      expect(out).toEqual({
        label: 'pbr-mesh-array-bgl',
        entries: [
          {
            binding: 0,
            visibility: 0x1,
            buffer: { type: 'read-only-storage', hasDynamicOffset: true },
          },
        ],
      });
    });

    it('storageBuffer=false: falls back to uniform', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-mesh-array',
        caps: { storageBuffer: false },
      });
      expect(out.entries[0]?.buffer?.type).toBe('uniform');
    });
  });

  describe('pbr-instances', () => {
    it('storageBuffer=true: 1 entry with read-only-storage, no dynamic offset', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-instances',
        caps: { storageBuffer: true },
      });
      expect(out).toEqual({
        label: 'pbr-instances-bgl',
        entries: [
          {
            binding: 0,
            visibility: 0x1,
            buffer: { type: 'read-only-storage', hasDynamicOffset: false },
          },
        ],
      });
    });

    it('storageBuffer=false: falls back to uniform', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-instances',
        caps: { storageBuffer: false },
      });
      expect(out.entries[0]?.buffer?.type).toBe('uniform');
    });
  });

  describe('pbr-skin-mesh-array', () => {
    it('storageBuffer=true: 2 entries, both dynamic offset', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'pbr-skin-mesh-array',
        caps: { storageBuffer: true },
      });
      expect(out).toEqual({
        label: 'pbr-skin-mesh-array-bgl',
        entries: [
          {
            binding: 0,
            visibility: 0x1,
            buffer: { type: 'read-only-storage', hasDynamicOffset: true },
          },
          {
            binding: 1,
            visibility: 0x1,
            buffer: { type: 'read-only-storage', hasDynamicOffset: true },
          },
        ],
      });
    });
  });

  describe('unlit-material', () => {
    it('7 entries: base PBR material only (no skylight injection)', () => {
      const spec = makeSpec();
      const out = buildBindGroupLayoutDescriptor(spec, {
        kind: 'unlit-material',
      });
      expect(out).toEqual({
        label: 'unlit-material-bgl',
        entries: buildPbrMaterialUserRegionEntries(),
      });
      expect(out.entries.length).toBe(7);
    });
  });
});

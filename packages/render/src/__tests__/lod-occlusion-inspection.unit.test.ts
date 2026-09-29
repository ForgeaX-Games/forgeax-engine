import { describe, expect, it } from 'vitest';
import {
  consumeLodOcclusionInspection,
  inspectLodOcclusion,
  LOD_OCCLUSION_INSPECTION_MAX_BYTES,
  serializeLodOcclusionInspection,
} from '../scene/visibility/inspection';

const baseInput = {
  root: { guid: '018e7a4d-1234-7abc-8def-000000000001', sourceKey: 'assets/lod-scene.gltf' },
  view: { attachmentId: 'main', cameraEntity: 7, viewRole: 'main' as const, viewGeneration: 3 },
  slot: { primitiveSlot: 11, slotGeneration: 2 },
  generation: 9,
  count: { candidates: 100_000, visible: 10_000, occluded: 90_000 },
  lodHistogram: [
    { level: 0, count: 5_000 },
    { level: 1, count: 4_000 },
    { level: 2, count: 1_000 },
  ],
  queryLatencyUs: { median: 42, p95: 91, last: 37 },
  pagePressure: { used: 1, capacity: 3 },
  fallback: { active: false as const },
  degradation: { active: false as const },
  samples: Array.from({ length: 80 }, (_, index) => ({
    primitiveSlot: index,
    level: index % 3,
    visible: index % 2 === 0,
  })),
};

describe('LOD occlusion inspection projection', () => {
  it('publishes bounded identity, histogram, timing, pressure and stable samples', () => {
    const inspection = inspectLodOcclusion(baseInput);

    expect(inspection.schema).toBe('forgeax::lod-occlusion-inspection::v2');
    expect(inspection.root).toEqual(baseInput.root);
    expect(inspection.view).toEqual(baseInput.view);
    expect(inspection.slot).toEqual(baseInput.slot);
    expect(inspection.count).toEqual(baseInput.count);
    expect(inspection.samples).toHaveLength(64);
    expect(inspection.samples[0]?.primitiveSlot).toBe(0);
    expect(inspection.samples[63]?.primitiveSlot).toBe(63);
    expect(JSON.stringify(inspection).length).toBeLessThanOrEqual(
      LOD_OCCLUSION_INSPECTION_MAX_BYTES,
    );
  });

  it('serializes as detached POD and exposes a CLI recovery branch', () => {
    const inspection = inspectLodOcclusion({
      ...baseInput,
      fallback: {
        active: true,
        reason: 'producer-failed',
        error: {
          code: 'asset-ddc-failed',
          expected: 'a published DDC payload',
          hint: 'inspect producer output, rebuild the source package, then retry',
          detail: { sourceKey: baseInput.root.sourceKey },
        },
      },
    });

    const serialized = serializeLodOcclusionInspection(inspection);
    expect(JSON.parse(serialized)).toEqual(inspection);
    expect(consumeLodOcclusionInspection(inspection)).toEqual({
      action: 'rebuild',
      sourceKey: baseInput.root.sourceKey,
      reason: 'producer-failed',
    });
    expect(serialized).not.toMatch(/handle|encoder|queue|mutable/i);
  });
});

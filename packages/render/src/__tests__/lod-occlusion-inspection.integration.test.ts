import { describe, expect, it } from 'vitest';
import { resolveInspectionBuild } from '../render-system';
import { inspectLodOcclusion } from '../scene/visibility/inspection';

describe('LOD occlusion inspection lifecycle', () => {
  it('uses the build-tool revision for inspection submits', () => {
    expect(resolveInspectionBuild({ build: 'merge-ref-123' })).toBe('merge-ref-123');
    expect(resolveInspectionBuild({ build: undefined })).toBe('render-system');
  });

  it('publishes one detached row per World attachment for a single submit', () => {
    const inspection = inspectLodOcclusion({
      root: { guid: '018e7a4d-1234-7abc-8def-000000000002', sourceKey: 'assets/lod-scene.gltf' },
      view: { attachmentId: 'world-a', cameraEntity: 1, viewRole: 'main', viewGeneration: 4 },
      slot: { primitiveSlot: 2, slotGeneration: 9 },
      generation: 10,
      count: { candidates: 2, visible: 1, occluded: 1 },
      lodHistogram: [{ level: 0, count: 2 }],
      queryLatencyUs: { median: 4, p95: 8, last: 3 },
      pagePressure: { used: 1, capacity: 3 },
      fallback: { active: false },
      degradation: { active: false },
      samples: [],
      submit: { frameId: 10, build: 'test-build', deviceGeneration: 2 },
      budget: {
        configuredQueryBudget: 2048,
        effectiveQueryBudget: 2048,
        settleSubmits: 98,
        retestSubmits: 44,
        expirySubmits: 88,
      },
      worlds: [
        {
          attachmentId: 'world-a',
          rows: [
            {
              root: {
                guid: '018e7a4d-1234-7abc-8def-000000000002',
                sourceKey: 'assets/lod-scene.gltf',
              },
              view: {
                attachmentId: 'world-a',
                cameraEntity: 1,
                viewRole: 'main',
                viewGeneration: 4,
              },
              slot: { primitiveSlot: 2, slotGeneration: 9 },
              generation: 10,
              count: { candidates: 2, visible: 1, occluded: 1 },
              lodHistogram: [{ level: 0, count: 2 }],
              queryLatencyUs: { median: 4, p95: 8, last: 3 },
              pagePressure: { used: 1, capacity: 3 },
              fallback: { active: false },
              degradation: { active: false },
              samples: [],
            },
          ],
        },
        {
          attachmentId: 'world-b',
          rows: [],
        },
      ],
    });

    expect(inspection.schema).toBe('forgeax::lod-occlusion-inspection::v2');
    expect(inspection.submit).toEqual({ frameId: 10, build: 'test-build', deviceGeneration: 2 });
    expect(inspection.budget.effectiveQueryBudget).toBe(2048);
    expect(inspection.worlds.map((world) => world.attachmentId)).toEqual(['world-a', 'world-b']);
    expect(inspection.worlds[0]?.attribution).toEqual({
      status: 'unavailable',
      reason: 'projection-only',
    });
    expect(inspection.worlds[0]?.rows[0]?.count).toEqual({
      candidates: 2,
      visible: 1,
      occluded: 1,
    });
    expect(Object.isFrozen(inspection.worlds)).toBe(true);
    expect(Object.isFrozen(inspection.worlds[0]?.rows)).toBe(true);
  });

  it('only accepts same-submit World attribution with the parent submit identity', () => {
    const submit = { frameId: 12, build: 'test-build', deviceGeneration: 2 };
    const row = {
      root: { guid: '018e7a4d-1234-7abc-8def-000000000002', sourceKey: 'assets/lod-scene.gltf' },
      view: {
        attachmentId: 'world-a',
        cameraEntity: 1,
        viewRole: 'main' as const,
        viewGeneration: 4,
      },
      slot: { primitiveSlot: 2, slotGeneration: 9 },
      generation: 12,
      count: { candidates: 2, visible: 1, occluded: 1 },
      lodHistogram: [{ level: 0, count: 2 }],
      queryLatencyUs: { median: 4, p95: 8, last: 3 },
      pagePressure: { used: 1, capacity: 3 },
      fallback: { active: false as const },
      degradation: { active: false as const },
      samples: [],
    };
    const inspection = inspectLodOcclusion({
      ...row,
      submit,
      worlds: [
        {
          attachmentId: 'world-a',
          attribution: { status: 'same-submit', submit },
          rows: [row],
        },
      ],
    });

    expect(inspection.worlds[0]?.attribution).toEqual({
      status: 'same-submit',
      submit,
    });
    expect(() =>
      inspectLodOcclusion({
        ...row,
        submit,
        worlds: [
          {
            attachmentId: 'world-a',
            attribution: {
              status: 'same-submit',
              submit: { ...submit, frameId: submit.frameId + 1 },
            },
            rows: [row],
          },
        ],
      }),
    ).toThrow('world attribution must reference the parent inspection submit');
  });

  it('joins reordered World rows by attachment identity, not array position', () => {
    const submit = { frameId: 20, build: 'test-build', deviceGeneration: 3 };
    const row = (attachmentId: string, primitiveSlot: number, candidates: number) => ({
      root: { guid: `asset-${attachmentId}`, sourceKey: `world:${attachmentId}` },
      view: {
        attachmentId,
        cameraEntity: 1,
        viewRole: 'main' as const,
        viewGeneration: 7,
      },
      slot: { primitiveSlot, slotGeneration: 11 },
      generation: 20,
      count: { candidates, visible: candidates - 1, occluded: 1 },
      lodHistogram: [{ level: 1, count: candidates }],
      queryLatencyUs: { median: 3, p95: 5, last: 2 },
      pagePressure: { used: 2, capacity: 12 },
      fallback: { active: false as const },
      degradation: { active: false as const },
      samples: [],
    });
    const inspection = inspectLodOcclusion({
      ...row('world-a', 4, 3),
      submit,
      worlds: [
        {
          attachmentId: 'world-b',
          attribution: { status: 'same-submit', submit },
          rows: [row('world-b', 9, 5)],
        },
        {
          attachmentId: 'world-a',
          attribution: { status: 'same-submit', submit },
          rows: [row('world-a', 4, 3)],
        },
      ],
    });

    const byAttachment = new Map(
      inspection.worlds.map((world) => [world.attachmentId, world] as const),
    );
    expect(byAttachment.get('world-a')?.rows[0]?.slot).toEqual({
      primitiveSlot: 4,
      slotGeneration: 11,
    });
    expect(byAttachment.get('world-b')?.rows[0]?.count.candidates).toBe(5);
    expect(byAttachment.get('world-b')?.attribution).toEqual({
      status: 'same-submit',
      submit,
    });
  });

  it('keeps identity and generation attached to a failed publication without suppressing draw', () => {
    const inspection = inspectLodOcclusion({
      root: { guid: '018e7a4d-1234-7abc-8def-000000000002', sourceKey: 'assets/lod-scene.gltf' },
      view: { attachmentId: 'main', cameraEntity: 1, viewRole: 'main', viewGeneration: 4 },
      slot: { primitiveSlot: 2, slotGeneration: 9 },
      generation: 10,
      count: { candidates: 100_000, visible: 100_000, occluded: 0 },
      lodHistogram: [{ level: 0, count: 100_000 }],
      queryLatencyUs: { median: 0, p95: 0, last: 0 },
      pagePressure: { used: 3, capacity: 3 },
      fallback: {
        active: true,
        reason: 'page-exhausted',
        error: {
          code: 'occlusion-query-unavailable',
          expected: 'a bounded query page reservation',
          hint: 'keep the candidate visible and retry on the next submitted frame',
          detail: { capacity: 3 },
        },
      },
      degradation: { active: true, reason: 'all-visible' },
      samples: [],
    });

    expect(inspection.fallback.active).toBe(true);
    expect(inspection.degradation).toEqual({ active: true, reason: 'all-visible' });
    expect(inspection.count.visible).toBe(inspection.count.candidates);
    expect(inspection.generation).toBe(10);
  });
});

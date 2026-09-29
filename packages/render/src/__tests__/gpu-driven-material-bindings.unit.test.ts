import { describe, expect, it } from 'vitest';
import { materialBindingKey, projectMaterialBindingClasses } from '../gpu-driven/material-bindings';
import type { ValidatedRenderable } from '../record/frame-snapshot';
import { buildReflectionProbeTable } from '../reflection/gpu-table';
import { defaultMaterialSnapshot } from '../render-system-extract';

function row(
  entityKey: number,
  deferredPass: boolean,
): Pick<ValidatedRenderable, 'source' | 'renderableIndex'> {
  const material = { ...defaultMaterialSnapshot(7), deferredPass };
  return {
    renderableIndex: entityKey,
    source: {
      worldId: 0,
      entityKey,
      assetHandle: 1,
      transform: { world: new Float32Array(16) },
      material,
      materials: [material],
      materialBindingSources: ['engine-default'],
    },
  };
}

describe('GPU material binding classes', () => {
  it.each([
    true,
    false,
  ])('retains probe bindings and observes real probe replacement (Deferred=%s)', (deferred) => {
    const receiver = row(1, deferred);
    const probes = (index: number) => ({
      selections: new Map([
        ['0:1', { kind: 'probe' as const, worldId: 0, entityKey: 7, normalizedDistance: 0 }],
      ]),
      table: buildReflectionProbeTable([
        {
          primitiveKey: '0:7',
          index,
          worldId: 0,
          entityKey: 7,
          center: [0, 0, 0],
          halfExtents: [1, 1, 1],
          intensity: 1,
          generation: 1,
        },
      ]),
    });
    const visible = projectMaterialBindingClasses([receiver], probes(2));
    const reindexed = { ...receiver, renderableIndex: 0 };
    expect([...projectMaterialBindingClasses([reindexed], probes(2))]).toEqual([...visible]);
    expect([...visible]).toEqual([
      [materialBindingKey(receiver.source, 7), `${deferred ? '' : 'forward'}|probe:2`],
    ]);
    expect([...projectMaterialBindingClasses([receiver], probes(3))]).not.toEqual([...visible]);
  });

  it('keeps authored Deferred membership independent of the camera index domain', () => {
    const receiver = row(1, true);
    const visible = projectMaterialBindingClasses([receiver]);
    const reindexed = { ...receiver, renderableIndex: 0 };
    const hidden = projectMaterialBindingClasses([reindexed]);
    expect([...hidden]).toEqual([...visible]);
    expect(hidden.size).toBe(0);
  });

  it('keeps Forward receivers classified without a camera dispatch', () => {
    const receiver = row(1, false);
    expect([...projectMaterialBindingClasses([receiver])]).toEqual([
      [materialBindingKey(receiver.source, 7), 'forward|probe:'],
    ]);
  });

  it('takes mixed submesh pass membership from each authored material', () => {
    const receiver = row(1, true);
    const mixed = {
      ...receiver,
      source: {
        ...receiver.source,
        materials: [
          receiver.source.material,
          { ...defaultMaterialSnapshot(8), deferredPass: false },
        ],
      },
    };
    expect([...projectMaterialBindingClasses([mixed])]).toEqual([
      [materialBindingKey(receiver.source, 8), 'forward|probe:'],
    ]);
  });
});

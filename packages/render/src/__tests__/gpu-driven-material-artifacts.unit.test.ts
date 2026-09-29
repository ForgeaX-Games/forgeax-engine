import {
  createMaterialShaderProgram,
  createStandardPbrArtifactReceipt,
  type MaterialShaderArtifact,
} from '@forgeax/engine-shader';
import { describe, expect, it, vi } from 'vitest';
import { collectGpuDrivenMaterialArtifacts } from '../gpu-driven/material-artifacts';
import type { PreparedGpuDrivenDraw } from '../gpu-driven/prepared-draw';
import type { RenderSystemInternals } from '../record/render-context';
import type { DispatchEntry, RenderableSnapshot } from '../render-system-extract';
import { defaultMaterialSnapshot } from '../render-system-extract';

const receipt = createStandardPbrArtifactReceipt();

function row(index: number) {
  const material = { ...defaultMaterialSnapshot(index + 1), materialShaderId: `material-${index}` };
  const prepared: PreparedGpuDrivenDraw = {
    identity: { material: material.materialShaderId, geometry: 'cube', deformation: 'rigid' },
    receiptGeneration: receipt.generation,
    receiptIdentity: receipt.receiptIdentity,
    directEntry: receipt.directEntry,
    sceneIndexEntry: receipt.sceneIndexEntry,
    materialRow: receipt.materialRow,
    resourceSlots: receipt.resourceSlots,
    uvSets: receipt.uvSets,
    vertexInputs: receipt.vertexInputs,
    alphaMask: receipt.alphaMask,
    skinPaletteAddress: receipt.skinPaletteAddress,
    topology: 'triangle-list',
    indexed: true,
    first: 0,
    count: 36,
    baseVertex: 0,
  };
  const source: RenderableSnapshot = {
    assetHandle: 1,
    worldId: 0,
    entityKey: index,
    transform: { world: new Float32Array(16) },
    material,
    materials: [material],
    materialBindingSources: ['engine-default'],
    gpuDrivenDraws: [
      {
        kind: 'indexed',
        first: 0,
        count: 36,
        baseVertex: 0,
        materialSlot: 0,
        topology: 'triangle-list',
        pipelineClass: 'pbr',
        materialResourceClass: '',
        prepared,
      },
    ],
  };
  return { source, renderableIndex: index };
}

function dispatch(index: number, id = `shadow-${index}`): DispatchEntry {
  return {
    entityIndex: index,
    materialHandle: index + 1,
    renderableIndex: index,
    passIndex: 0,
    queue: 2000,
    layer: 0,
    tags: { LightMode: 'ShadowCaster' },
    renderState: undefined,
    defines: undefined,
    paramSnapshot: undefined,
    materialShaderId: id,
    vertexEntry: `${id}_vs`,
    fragmentEntry: `${id}_fs`,
  };
}

function artifact(id: string): MaterialShaderArtifact {
  return {
    material: id,
    pass: 'Forward',
    program: createMaterialShaderProgram(''),
    layoutIdentity: receipt.reflection.layoutIdentity,
    bindings: [],
    deps: [],
    vertexInputs: [],
    receipt,
  };
}

function collect(rows: ReturnType<typeof row>[], shadowDispatch: DispatchEntry[]) {
  return collectGpuDrivenMaterialArtifacts({
    rows,
    dispatch: shadowDispatch,
    resolve: (id) => artifact(id),
    clustered: false,
    reflectionFallback: false,
  });
}

describe('GPU-driven material artifact selection', () => {
  it('preserves authored Forward entries and observes their replacement', () => {
    const rows = [row(0)];
    const forward = {
      ...dispatch(0, 'material-0'),
      tags: { LightMode: 'Forward' },
      vertexEntry: 'vs_authored',
      fragmentEntry: 'fs_authored',
    };
    const before = collect(rows, [forward, dispatch(0)]);
    const selected = [...before.materialArtifacts.values()][0];
    expect(selected?.vertexEntry).toBe('vs_authored');
    expect(selected?.fragmentEntry).toBe('fs_authored');
    const after = collect(rows, [{ ...forward, fragmentEntry: 'fs_replacement' }, dispatch(0)]);
    expect([...after.materialArtifacts.values()][0]?.fragmentEntry).toBe('fs_replacement');
  });

  it('resolves a shared program once per request for retained receivers in both passes', () => {
    const shared = row(0);
    const rows = Array.from({ length: 300 }, (_, renderableIndex) => ({
      ...shared,
      renderableIndex,
    }));
    const resolve = vi.fn((id: string) => artifact(id));
    const result = collectGpuDrivenMaterialArtifacts({
      rows,
      dispatch: [],
      resolve,
      clustered: false,
      reflectionFallback: false,
    });
    expect(result.materialArtifacts.size).toBe(1);
    expect(result.shadowMaterialArtifacts.size).toBe(1);
    expect(resolve.mock.calls).toHaveLength(2);
  });

  it('keeps skin and vertex-color variants distinct when receivers share a shader', () => {
    const shared = row(0);
    const draw = shared.source.gpuDrivenDraws?.[0];
    if (draw?.prepared === undefined) throw new Error('missing prepared test draw');
    const prepared = draw.prepared;
    const rows = (['rigid', 'skin'] as const).flatMap((deformation) =>
      [false, true].map((color) => {
        const variant = createStandardPbrArtifactReceipt(deformation === 'skin', color);
        return {
          ...shared,
          source: {
            ...shared.source,
            gpuDrivenDraws: [
              {
                ...draw,
                prepared: {
                  ...prepared,
                  identity: { ...prepared.identity, deformation },
                  receiptIdentity: variant.receiptIdentity,
                  vertexInputs: variant.vertexInputs,
                },
              },
            ],
          },
        };
      }),
    );
    const resolve = vi.fn<NonNullable<RenderSystemInternals['getMaterialShaderArtifact']>>(
      (id, request) => {
        if (typeof request !== 'object') throw new Error('expected structured material request');
        return {
          ...artifact(id),
          receipt: createStandardPbrArtifactReceipt(
            request.deformation === 'skin',
            request.vertexColorAvailable,
          ),
        };
      },
    );
    const result = collectGpuDrivenMaterialArtifacts({
      rows,
      dispatch: [],
      resolve,
      clustered: true,
      reflectionFallback: true,
    });
    expect(result.materialArtifacts.size).toBe(4);
    expect(result.shadowMaterialArtifacts.size).toBe(4);
    expect(resolve.mock.calls).toHaveLength(8);
  });

  it('keeps entry selection independent and rechecks admission for every receiver', () => {
    const shared = row(0);
    const draw = shared.source.gpuDrivenDraws?.[0];
    const prepared = draw?.prepared;
    const materialHandle = shared.source.material.materialHandle;
    if (draw === undefined || prepared === undefined || materialHandle === undefined)
      throw new Error('missing prepared test draw');
    const rows = [0, 1, 2].map((renderableIndex) => ({ ...shared, renderableIndex }));
    const invalid = {
      source: {
        ...shared.source,
        gpuDrivenDraws: [
          {
            ...draw,
            prepared: { ...prepared, receiptGeneration: receipt.generation + 1, vertexInputs: [] },
          },
        ],
      },
      renderableIndex: 3,
    };
    const entries = [0, 1, 2, 3].map((index) => ({
      ...dispatch(index, 'shared-shadow'),
      materialHandle,
      fragmentEntry: index === 1 ? 'fs_alternate' : 'fs_main',
    }));
    const resolve = vi.fn((id: string) => artifact(id));
    const result = collectGpuDrivenMaterialArtifacts({
      rows: [...rows, invalid],
      dispatch: entries,
      resolve,
      clustered: false,
      reflectionFallback: false,
    });
    expect(result.materialArtifacts.size).toBe(1);
    expect(result.shadowMaterialArtifacts.size).toBe(1);
    expect([...result.shadowMaterialArtifacts.values()][0]?.fragmentEntry).toBe('fs_main');
    // One main request and two distinct selected shadow entries. The invalid
    // receiver shares a program, but cannot bypass its own ABI/input checks.
    expect(resolve.mock.calls).toHaveLength(3);
  });

  it('caches missing publications only for the current collection', () => {
    const shared = row(0);
    const rows = Array.from({ length: 50 }, (_, renderableIndex) => ({
      ...shared,
      renderableIndex,
    }));
    const resolve = vi.fn<(id: string) => MaterialShaderArtifact | undefined>(() => undefined);
    const input = {
      rows,
      dispatch: [],
      resolve,
      clustered: false,
      reflectionFallback: false,
    };
    expect(collectGpuDrivenMaterialArtifacts(input).materialArtifacts.size).toBe(0);
    expect(resolve.mock.calls).toHaveLength(2);
    resolve.mockImplementation((id) => ({
      ...artifact(id),
      program: createMaterialShaderProgram('new publication'),
    }));
    const recovered = collectGpuDrivenMaterialArtifacts(input);
    expect([...recovered.materialArtifacts.values()][0]?.program.source).toBe('new publication');
    expect(resolve.mock.calls).toHaveLength(4);
  });

  it('indexes shadow dispatch once instead of rescanning it for each prepared draw', () => {
    const count = 64;
    const rows = Array.from({ length: count }, (_, index) => row(index));
    let tagReads = 0;
    const entries = rows.map((_, index) => ({
      ...dispatch(index),
      tags: {
        get LightMode() {
          tagReads += 1;
          return 'ShadowCaster';
        },
      },
    }));
    const result = collect(rows, entries);
    expect(result.shadowMaterialArtifacts.size).toBe(count);
    for (const [index, selected] of [...result.shadowMaterialArtifacts.values()].entries()) {
      expect(selected.material).toBe(`shadow-${index}`);
      expect(selected.vertexEntry).toBe(`shadow-${index}_vs`);
      expect(selected.fragmentEntry).toBe(`shadow-${index}_fs`);
    }
    expect(tagReads).toBeLessThanOrEqual(count * 2);
  });

  it('keeps entry points with the selected last shadow program for a repeated draw key', () => {
    const first = dispatch(0, 'first');
    const last = { ...dispatch(0, 'last'), passIndex: 1 };
    const selected = [...collect([row(0)], [first, last]).shadowMaterialArtifacts.values()][0];
    expect(selected?.material).toBe('last');
    expect(selected?.vertexEntry).toBe('last_vs');
    expect(selected?.fragmentEntry).toBe('last_fs');
  });

  it('re-reads dispatch and program entries on the next collection', () => {
    const rows = [row(0)];
    const entries = [dispatch(0, 'before')];
    const before = collect(rows, entries);
    entries[0] = dispatch(0, 'after');
    const after = collect(rows, entries);
    expect([...before.shadowMaterialArtifacts.values()][0]?.vertexEntry).toBe('before_vs');
    expect([...after.shadowMaterialArtifacts.values()][0]?.vertexEntry).toBe('after_vs');
  });
});

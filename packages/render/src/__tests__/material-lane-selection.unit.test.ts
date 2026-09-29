import { describe, expect, it } from 'vitest';
import {
  buildMatchedMaterialHandlesByRenderable,
  filterDispatchBySelector,
} from '../record/shadow-pass';
import type { DispatchEntry } from '../render-system-extract';

function entry(renderableIndex: number, materialHandle: number, lightMode: string): DispatchEntry {
  return {
    entityIndex: renderableIndex,
    renderableIndex,
    materialHandle,
    passIndex: 0,
    queue: 2000,
    layer: 0,
    tags: { LightMode: lightMode },
    renderState: undefined,
    defines: undefined,
    vertexEntry: 'vs_main',
    fragmentEntry: lightMode === 'Deferred' ? 'fs_gbuffer' : 'fs_main',
    materialShaderId: 'forgeax::default-standard-pbr',
    paramSnapshot: undefined,
  };
}

describe('material membership across graph lanes', () => {
  const dispatch = [
    entry(0, 1, 'Forward'),
    entry(0, 1, 'Deferred'),
    entry(0, 2, 'Forward'),
    entry(1, 2, 'Deferred'),
    entry(1, 3, 'Forward'),
  ];
  it('selects G-buffer entries by renderable and material without admitting Forward-only slots', () => {
    const selected = buildMatchedMaterialHandlesByRenderable(dispatch, { LightMode: ['Deferred'] });
    expect([...(selected ?? [])].map(([index, handles]) => [index, [...handles]])).toEqual([
      [0, [1]],
      [1, [2]],
    ]);
    const draws = filterDispatchBySelector(dispatch, { LightMode: ['Deferred'] }).filter((draw) =>
      selected?.get(draw.renderableIndex)?.has(draw.materialHandle),
    );
    expect(draws.map((draw) => draw.fragmentEntry)).toEqual(['fs_gbuffer', 'fs_gbuffer']);
  });
  it('keeps the later Forward-only lane disjoint from Deferred membership', () => {
    const selected = buildMatchedMaterialHandlesByRenderable(
      dispatch,
      { LightMode: ['Forward'] },
      { LightMode: ['Deferred'] },
    );
    expect([...(selected ?? [])].map(([index, handles]) => [index, [...handles]])).toEqual([
      [0, [2]],
      [1, [3]],
    ]);
  });
});

import { describe, expect, it } from 'vitest';
import { hasSsrSceneInputs, selectMainPassMaterials } from '../record/main-pass';
import {
  type DispatchEntry,
  defaultMaterialSnapshot,
  type MaterialSnapshot,
} from '../render-system-extract';

type SelectionContext = Parameters<typeof hasSsrSceneInputs>[0];

function material(handle: number, options: Partial<MaterialSnapshot> = {}): MaterialSnapshot {
  return { ...defaultMaterialSnapshot(handle), materialShaderId: `cooked:${handle}`, ...options };
}

function row(
  index: number,
  materials: readonly MaterialSnapshot[],
): SelectionContext['validatedOrdered'][number] {
  return {
    renderableIndex: index,
    source: { material: materials[0], materials },
  } as unknown as SelectionContext['validatedOrdered'][number];
}

function pass(index: number, handle: number, lightMode: string): DispatchEntry {
  return {
    entityIndex: index,
    materialHandle: handle,
    renderableIndex: index,
    passIndex: 0,
    queue: 2000,
    layer: 0,
    tags: { LightMode: lightMode },
    renderState: undefined,
    defines: undefined,
    vertexEntry: undefined,
    fragmentEntry: undefined,
    materialShaderId: undefined,
    paramSnapshot: undefined,
  };
}

function context(
  materials: readonly MaterialSnapshot[],
  dispatch: readonly DispatchEntry[],
): SelectionContext {
  return { validatedOrdered: [row(0, materials)], dispatch };
}

describe('SSR receiver selection', () => {
  it('admits a cooked opaque Deferred receiver by its selected handle, not the representative material', () => {
    const c = context(
      [material(1), material(2, { deferredPass: true })],
      [pass(0, 1, 'Forward'), pass(0, 2, 'Deferred')],
    );
    expect(selectMainPassMaterials(c, { LightMode: ['Deferred'] }, 'opaque')?.get(0)).toEqual(
      new Set([2]),
    );
    expect(hasSsrSceneInputs(c, 'deferred')).toBe(true);
  });

  it('ignores later blended and medium submeshes while retaining the opaque receiver', () => {
    const c = context(
      [
        material(1, { transparent: true }),
        material(2, { deferredPass: true }),
        material(3, { surfaceModel: 'single-layer-medium' }),
      ],
      [pass(0, 1, 'Forward'), pass(0, 2, 'Deferred'), pass(0, 3, 'Forward')],
    );
    expect(hasSsrSceneInputs(c, 'deferred')).toBe(true);
    expect(selectMainPassMaterials(c, { LightMode: ['Forward'] }, 'transparent')?.get(0)).toEqual(
      new Set([1]),
    );
    expect(selectMainPassMaterials(c, undefined, 'single-layer-medium-color')?.get(0)).toEqual(
      new Set([3]),
    );
  });

  it('does not let a qualified first submesh hide an illegal selected writer', () => {
    const c = context(
      [material(1, { deferredPass: true }), material(2)],
      [pass(0, 1, 'Deferred'), pass(0, 2, 'Deferred')],
    );
    expect(hasSsrSceneInputs(c, 'deferred')).toBe(false);
  });

  it('fails closed when a selected handle has no resolved material snapshot', () => {
    const c = context([material(1, { deferredPass: true })], [pass(0, 99, 'Deferred')]);
    expect(hasSsrSceneInputs(c, 'deferred')).toBe(false);
  });

  it('requires at least one receiver across the selected renderables', () => {
    const c: SelectionContext = {
      validatedOrdered: [
        row(0, [material(1, { transparent: true })]),
        row(1, [material(2, { deferredPass: true })]),
      ],
      dispatch: [pass(0, 1, 'Forward'), pass(1, 2, 'Deferred')],
    };
    expect(hasSsrSceneInputs(c, 'deferred')).toBe(true);
    expect(hasSsrSceneInputs({ validatedOrdered: [], dispatch: [] }, 'deferred')).toBe(false);
  });

  it.each([
    material(1),
    material(1, { transparent: true, deferredPass: true }),
    material(1, { surfaceModel: 'single-layer-medium', deferredPass: true }),
  ])('declines all-forward, all-transparent and all-medium selections', (only) => {
    const mode = only.deferredPass === true ? 'Deferred' : 'Forward';
    expect(hasSsrSceneInputs(context([only], [pass(0, 1, mode)]), 'deferred')).toBe(false);
  });

  it('keeps the original strict forward output qualification', () => {
    const canonical = material(1, { materialShaderId: 'forgeax::default-standard-pbr' });
    expect(hasSsrSceneInputs(context([canonical], [pass(0, 1, 'Forward')]), 'forward')).toBe(true);
    expect(
      hasSsrSceneInputs(
        context([material(1, { deferredPass: true })], [pass(0, 1, 'Deferred')]),
        'forward',
      ),
    ).toBe(false);
    expect(
      hasSsrSceneInputs(
        {
          validatedOrdered: [row(0, [canonical]), row(1, [material(2, { transparent: true })])],
          dispatch: [pass(0, 1, 'Forward'), pass(1, 2, 'Forward')],
        },
        'forward',
      ),
    ).toBe(false);
    expect(hasSsrSceneInputs({ validatedOrdered: [], dispatch: [] }, 'forward')).toBe(false);
  });
});

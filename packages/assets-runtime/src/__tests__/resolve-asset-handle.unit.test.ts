// @forgeax/engine-assets-runtime -- resolveAssetHandle + material-walk coverage
// (fix issue #709). Exercises the two-tier slot dispatch (builtin vs user-tier),
// the stale/released/not-found error arms, and the material parent-chain walk
// (single, inherited, override-by-name, missing-parent, cycle).

import { World } from '@forgeax/engine-ecs';
import type { Asset, Handle, MaterialAsset } from '@forgeax/engine-types';
import { BUILTIN_BASE, toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { HANDLE_CUBE } from '../handles';
import { resolveAssetHandle, walkMaterialPassesOverSharedRefs } from '../resolve-asset-handle';

describe('resolveAssetHandle two-tier dispatch', () => {
  it('resolves a builtin mesh handle (slot < BUILTIN_BASE)', () => {
    const res = resolveAssetHandle(new World(), HANDLE_CUBE as Handle<string, 'shared'>);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((res.value as { kind: string }).kind).toBe('mesh');
  });

  it('errors with asset-not-found for an unoccupied builtin slot', () => {
    const bogus = toShared<'MeshAsset'>(999); // in [1, BUILTIN_BASE) but not a real builtin
    const res = resolveAssetHandle(new World(), bogus as Handle<string, 'shared'>);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.error as { code: string }).code).toBe('asset-not-found');
  });

  it('resolves a user-tier handle minted via allocSharedRef', () => {
    const world = new World();
    const payload = { kind: 'material', passes: [] } as unknown as Asset;
    const handle = world.allocSharedRef('MaterialAsset', payload);
    const res = resolveAssetHandle(world, handle as Handle<string, 'shared'>);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toBe(payload);
  });

  it('forwards the stale error after the handle slot is released + re-allocated', () => {
    const world = new World();
    const handle = world.allocSharedRef('MaterialAsset', { kind: 'material' } as unknown as Asset);
    world.sharedRefs.release(handle as Handle<string, 'shared'>);
    // Releasing bumps the slot generation, so the stale handle now resolves to
    // the transparently-forwarded shared-ref-stale error (D-3 / AC-10), not a
    // flattened asset-not-found.
    const res = resolveAssetHandle(world, handle as Handle<string, 'shared'>);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.error as { code: string }).code).toBe('shared-ref-stale');
  });

  it('errors with asset-not-found for an unallocated user-tier slot', () => {
    const res = resolveAssetHandle(
      new World(),
      toShared<'MeshAsset'>(BUILTIN_BASE + 5) as Handle<string, 'shared'>,
    );
    expect(res.ok).toBe(false);
  });
});

function mat(over: Partial<MaterialAsset>): MaterialAsset {
  return { kind: 'material', ...over } as MaterialAsset;
}

describe('walkMaterialPassesOverSharedRefs', () => {
  it('returns the passes of a single childless material', () => {
    const world = new World();
    const handle = world.allocSharedRef(
      'MaterialAsset',
      mat({ passes: [{ name: 'main', shader: 'forgeax::standard' }], paramValues: { a: 1 } }),
    );
    const res = walkMaterialPassesOverSharedRefs(world, handle, { lookup: () => undefined });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.passes.map((p) => p.name)).toEqual(['main']);
    expect(res.value.paramValues).toEqual({ a: 1 });
  });

  it('inherits parent passes when the child declares none, merging paramValues', () => {
    const world = new World();
    const parent = mat({
      passes: [{ name: 'base', shader: 'forgeax::standard' }],
      paramValues: { a: 1, b: 2 },
    });
    const child = mat({ parent: 'p-guid' as never, paramValues: { b: 20 } });
    const handle = world.allocSharedRef('MaterialAsset', child);
    const res = walkMaterialPassesOverSharedRefs(world, handle, { lookup: () => parent });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.passes.map((p) => p.name)).toEqual(['base']);
    expect(res.value.paramValues).toEqual({ a: 1, b: 20 }); // child overrides
  });

  it('child passes override parent by name and append new ones', () => {
    const world = new World();
    const parent = mat({
      passes: [
        { name: 'shadow', shader: 'forgeax::shadow' },
        { name: 'main', shader: 'forgeax::parent-main' },
      ],
    });
    const child = mat({
      parent: 'p-guid' as never,
      passes: [
        { name: 'main', shader: 'forgeax::child-main' },
        { name: 'extra', shader: 'forgeax::extra' },
      ],
    });
    const handle = world.allocSharedRef('MaterialAsset', child);
    const res = walkMaterialPassesOverSharedRefs(world, handle, { lookup: () => parent });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const byName = new Map(res.value.passes.map((p) => [p.name, p.shader]));
    expect(byName.get('main')).toBe('forgeax::child-main'); // overridden
    expect(byName.get('extra')).toBe('forgeax::extra'); // appended
    expect(byName.get('shadow')).toBe('forgeax::shadow'); // inherited
  });

  it('errors (empty-passes / missing-parent) when the parent is not catalogued', () => {
    const world = new World();
    const child = mat({ parent: 'missing-guid' as never });
    const handle = world.allocSharedRef('MaterialAsset', child);
    const res = walkMaterialPassesOverSharedRefs(world, handle, { lookup: () => undefined });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.error as { code: string }).code).toBe('material-resolved-empty-passes');
  });

  it('detects a parent cycle', () => {
    const world = new World();
    // A -> B -> A: lookup returns a material whose parent points back.
    const a = mat({ parent: 'guid-b' as never });
    const b = mat({ parent: 'guid-a' as never });
    const handle = world.allocSharedRef('MaterialAsset', a);
    const registry = {
      lookup: (guid: string | { toString(): string }) => {
        const g = String(guid).toLowerCase();
        if (g.includes('guid-b')) return b;
        if (g.includes('guid-a')) return a;
        return undefined;
      },
    };
    const res = walkMaterialPassesOverSharedRefs(world, handle, registry as never);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect((res.error as { code: string }).code).toBe('material-circular-inheritance');
  });
});

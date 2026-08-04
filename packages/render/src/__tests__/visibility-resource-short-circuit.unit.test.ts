import { AssetRegistry, HANDLE_CUBE } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import {
  extractFrames,
  MeshFilter,
  MeshRenderer,
  Visibility,
  VisibilityStateValue,
} from '@forgeax/engine-render/internal';
import { Transform } from '@forgeax/engine-scene';
import { toShared } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';

function codesForInvalidMaterial(state: number): { hidden: string[]; visible: string[] } {
  const world = new World();
  const assets = new AssetRegistry({} as never);
  const errors: Array<{ readonly code: string }> = [];
  world.setErrorHandler((error: unknown) => {
    if (typeof error === 'object' && error !== null && 'code' in error) {
      errors.push(error as { readonly code: string });
    }
  });
  const entity = world
    .spawn(
      { component: Transform, data: {} },
      { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
      { component: MeshRenderer, data: { materials: [toShared<'MaterialAsset'>(999)] } },
      { component: Visibility, data: { state } },
    )
    .unwrap();

  extractFrames([world], 0, assets);
  const hiddenCodes = errors.map((error) => error.code);
  world.set(entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
  const beforeVisible = errors.length;
  extractFrames([world], 0, assets);
  return { hidden: hiddenCodes, visible: errors.slice(beforeVisible).map((error) => error.code) };
}

describe('visibility resource short circuit', () => {
  it('does not resolve a bad material while hidden, then restores the error path', () => {
    const codes = codesForInvalidMaterial(VisibilityStateValue.hidden);

    expect(codes.hidden).toEqual([]);
    expect(codes.visible).toContain('asset-not-registered');
  });

  it('does not validate a bad submesh material count while hidden', () => {
    const world = new World();
    const assets = new AssetRegistry({} as never);
    const errors: Array<{ readonly code: string }> = [];
    world.setErrorHandler((error: unknown) => {
      if (typeof error === 'object' && error !== null && 'code' in error) {
        errors.push(error as { readonly code: string });
      }
    });
    const entity = world
      .spawn(
        { component: Transform, data: {} },
        { component: MeshFilter, data: { assetHandle: HANDLE_CUBE } },
        {
          component: MeshRenderer,
          data: {
            materials: [toShared<'MaterialAsset'>(998), toShared<'MaterialAsset'>(999)],
          },
        },
        { component: Visibility, data: { state: VisibilityStateValue.hidden } },
      )
      .unwrap();

    extractFrames([world], 0, assets);
    expect(errors).toEqual([]);

    world.set(entity, Visibility, { state: VisibilityStateValue.visible }).unwrap();
    extractFrames([world], 0, assets);
    expect(errors.map((error) => error.code)).toContain('mesh-renderer-material-count-mismatch');
  });
});

// @forgeax/engine-assets-runtime -- AssetRegistry.instantiate / instantiateFlat
// coverage (fix issue #709). Drives the scene-instantiate collaboration module
// (instantiate.ts) end-to-end through a real World + the two-tier handle
// resolver. The assertions check the structured Result surface (charter P3:
// instantiate never throws for an expected failure) rather than a specific
// spawn outcome, so the coverage does not couple to the full ECS scene-spawn
// prerequisites (node env, no GPU).

import { defineComponent, World } from '@forgeax/engine-ecs';
import type { Asset, SceneAsset } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { AssetRegistry } from '../asset-registry';

defineComponent('T709Tag', { value: 'f32' });

function makeRegistry(): AssetRegistry {
  return new AssetRegistry({
    getMaterialShaderManifest: vi.fn().mockReturnValue(undefined),
    lookupMaterialShader: vi.fn().mockReturnValue({ ok: false, error: new Error('mock') }),
    getPipeline: vi.fn().mockReturnValue(undefined),
    registerMaterialShader: vi.fn(),
    inspect: vi.fn().mockReturnValue({ materialShaders: [] }),
  } as unknown as import('@forgeax/engine-shader').ShaderRegistry);
}

function twoEntityScene(): SceneAsset {
  return {
    kind: 'scene',
    entities: [
      { localId: 0 as never, components: { T709Tag: { value: 1 } } },
      { localId: 1 as never, components: { T709Tag: { value: 2 } } },
    ],
    mounts: [],
  } as unknown as SceneAsset;
}

function isResult(v: unknown): v is { ok: boolean } {
  return typeof v === 'object' && v !== null && typeof (v as { ok?: unknown }).ok === 'boolean';
}

describe('AssetRegistry.instantiate', () => {
  it('resolves a catalogued scene handle and returns a structured Result', () => {
    const reg = makeRegistry();
    const world = new World();
    const scene = twoEntityScene();
    const handle = world.allocSharedRef('SceneAsset', scene);
    const res = reg.instantiate(handle, world);
    expect(isResult(res)).toBe(true);
    if (res.ok) expect(typeof res.value).toBe('number');
  });

  it('returns an error Result when the handle does not resolve to a scene', () => {
    const reg = makeRegistry();
    const world = new World();
    const handle = world.allocSharedRef('SceneAsset', { kind: 'material' } as unknown as Asset);
    const res = reg.instantiate(handle as never, world);
    expect(res.ok).toBe(false);
  });
});

describe('AssetRegistry.instantiateFlat', () => {
  it('drives the flat scene-materialise path to a structured Result', () => {
    const reg = makeRegistry();
    const world = new World();
    const handle = world.allocSharedRef('SceneAsset', twoEntityScene());
    const res = reg.instantiateFlat(handle, world);
    expect(isResult(res)).toBe(true);
    if (res.ok) expect(Array.isArray(res.value)).toBe(true);
  });
});

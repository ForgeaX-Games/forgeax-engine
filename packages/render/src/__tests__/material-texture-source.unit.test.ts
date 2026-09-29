import { World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import {
  collectMaterialTextureSources,
  type MaterialTextureSourceCache,
  materialTextureSourceFields,
} from '../render-system-extract';
import type { RenderTargetDescriptor } from '../targets/contracts';
import {
  createRenderTargetMaterialSource,
  resolveRenderTargetMaterialSource,
} from '../targets/material-source';
import { createRenderTargetOwner } from '../targets/owner';
import { CanvasTexture } from '../textures/canvas-texture';

const descriptor: RenderTargetDescriptor = {
  shape: '2d',
  width: 8,
  height: 8,
  format: 'rgba8unorm',
  mipLevels: 1,
  sampleCount: 1,
  sampled: true,
  readback: false,
};

describe('material texture source projection', () => {
  it('admits only schema-declared texture fields for numeric source handles', () => {
    const world = new World();
    const owner = createRenderTargetOwner({
      rendererId: Symbol('material-source'),
      getGeneration: () => 1,
    });
    const target = owner.create(descriptor);
    expect(target.ok).toBe(true);
    if (!target.ok) return;
    const binding = createRenderTargetMaterialSource(target.value, descriptor, {
      aspect: 'color',
      dimension: '2d',
      mipLevel: 0,
      generation: 1,
    });
    expect(binding.ok).toBe(true);
    if (!binding.ok) return;
    const handle = world.internSharedRef('RenderTargetTextureSource', binding.value.source);
    const stats = {
      sourceFieldsVisited: 0,
      numericSharedRefProbes: 0,
      sourceCacheHits: 0,
      sourceCacheMisses: 0,
      producerRoutes: {},
    };
    const cache: MaterialTextureSourceCache = new Map();
    const sources = collectMaterialTextureSources(
      { roughness: Number(handle), baseColorTexture: Number(handle) },
      world,
      new Set(['baseColorTexture']),
      stats,
      cache,
    );
    collectMaterialTextureSources(
      { baseColorTexture: Number(handle) },
      world,
      new Set(['baseColorTexture']),
      stats,
      cache,
    );
    expect(sources.get('baseColorTexture')).toBe(binding.value.source);
    expect(sources.has('roughness')).toBe(false);
    expect(stats).toMatchObject({
      sourceFieldsVisited: 2,
      numericSharedRefProbes: 2,
      sourceCacheMisses: 1,
      sourceCacheHits: 1,
    });
    expect(resolveRenderTargetMaterialSource(binding.value.source)).toBeDefined();
  });

  it('derives source fields from the published param schema', () => {
    const fields = materialTextureSourceFields([
      { name: 'roughness', type: 'f32' },
      { name: 'albedo', type: 'texture2d' },
      { name: 'normal', type: 'texture2d_array' },
      { name: 'sampler', type: 'sampler' },
    ]);
    expect([...(fields ?? [])]).toEqual(['albedo', 'normal']);
  });
});

it('binds Canvas to a declared material texture slot through the ordinary shared reference', () => {
  const world = new World();
  const texture = new CanvasTexture({ width: 8, height: 8 } as OffscreenCanvas);
  const handle = world.allocSharedRef('CanvasTextureSource', texture.source);
  const values = { baseColorTexture: { texture: handle }, roughness: Number(handle) };
  const sources = collectMaterialTextureSources(values, world, new Set(['baseColorTexture']));
  expect([...sources]).toEqual([['baseColorTexture', texture.source]]);
  expect(structuredClone(texture.source)).toEqual(texture.source);
  texture.dispose();
  texture.update();
});

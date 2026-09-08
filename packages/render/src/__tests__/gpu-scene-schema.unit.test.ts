import { describe, expect, it } from 'vitest';
import { GPU_SCENE_LAYOUTS, GPU_SCENE_WGSL, gpuSceneFieldOffset } from '../gpu-scene-schema';

describe('GPU Scene schema derivation', () => {
  it('derives CPU strides, offsets, and WGSL from one field roster', () => {
    expect(GPU_SCENE_LAYOUTS.primitive.stride).toBe(64);
    expect(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'localBoundsMin')).toBe(32);
    expect(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.primitive, 'localBoundsMax')).toBe(48);
    expect(GPU_SCENE_LAYOUTS.transform.stride).toBe(128);
    expect(gpuSceneFieldOffset(GPU_SCENE_LAYOUTS.transform, 'previousWorld')).toBe(64);
    expect(GPU_SCENE_WGSL).toContain('struct GpuScenePrimitive');
    expect(GPU_SCENE_WGSL).toContain('currentWorld: mat4x4<f32>');
    expect(GPU_SCENE_WGSL).toContain('struct GpuSceneMaterial');
    expect(GPU_SCENE_WGSL).toContain('baseVertex: i32');
  });
});

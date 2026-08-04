import type { RhiCanvasContext, RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { configureSurface } from '../render-system';

function device(backendKind: 'webgpu' | 'wgpu-webgl2'): RhiDevice {
  return {
    limits: { maxStorageBuffersPerShaderStage: 0 },
    caps: { backendKind },
  } as unknown as RhiDevice;
}

describe('configureSurface', () => {
  it('keeps COPY_SRC on a low-capability WebGPU surface', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = { configure } as unknown as RhiCanvasContext;
    const webGpuDevice = device('webgpu');
    const result = configureSurface(context, webGpuDevice, 'bgra8unorm', 'bgra8unorm-srgb');
    expect(result.ok).toBe(true);
    expect(configure).toHaveBeenCalledWith({
      device: webGpuDevice,
      format: 'bgra8unorm-srgb',
      alphaMode: 'opaque',
      usage: 0x10 | 0x01,
    });
  });

  it('keeps the wgpu WebGL2 surface COLOR_TARGET-only', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = { configure } as unknown as RhiCanvasContext;
    const webGlDevice = device('wgpu-webgl2');
    const result = configureSurface(context, webGlDevice, 'bgra8unorm', 'bgra8unorm-srgb');
    expect(result.ok).toBe(true);
    expect(configure).toHaveBeenCalledWith({
      device: webGlDevice,
      format: 'bgra8unorm-srgb',
      alphaMode: 'opaque',
      usage: 0x10,
    });
  });
});

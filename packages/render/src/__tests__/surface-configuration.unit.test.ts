import type { RhiCanvasContext, RhiDevice } from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-rhi';
import { describe, expect, it, vi } from 'vitest';
import { configureSurface } from '../render-system';

function device(backendKind: 'webgpu' | 'wgpu-webgl2', storageBuffer = false): RhiDevice {
  return {
    limits: { maxStorageBuffersPerShaderStage: 0 },
    caps: { backendKind, storageBuffer },
  } as unknown as RhiDevice;
}

describe('configureSurface', () => {
  it('keeps native WebGPU sRGB view support when texture binding is available', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = { configure } as unknown as RhiCanvasContext;
    const webGpuDevice = device('webgpu', true);
    const result = configureSurface(context, webGpuDevice, 'bgra8unorm', 'bgra8unorm-srgb');
    expect(result.ok).toBe(true);
    expect(configure).toHaveBeenCalledWith({
      device: webGpuDevice,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied',
      usage: 0x10 | 0x04 | 0x01,
      viewFormats: ['bgra8unorm-srgb'],
    });
  });

  it('keeps COPY_SRC on a low-capability WebGPU surface', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = { configure } as unknown as RhiCanvasContext;
    const webGpuDevice = device('webgpu');
    const result = configureSurface(context, webGpuDevice, 'bgra8unorm', 'bgra8unorm-srgb');
    expect(result.ok).toBe(true);
    expect(configure).toHaveBeenCalledWith({
      device: webGpuDevice,
      format: 'bgra8unorm',
      alphaMode: 'premultiplied',
      usage: 0x10 | 0x01,
      viewFormats: ['bgra8unorm-srgb'],
    });
  });

  it('keeps the wgpu WebGL2 surface COLOR_TARGET-only', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = { configure } as unknown as RhiCanvasContext;
    const webGlDevice = device('wgpu-webgl2');
    const result = configureSurface(context, webGlDevice, 'rgba8unorm', 'rgba8unorm-srgb');
    expect(result.ok).toBe(true);
    expect(configure).toHaveBeenCalledWith({
      device: webGlDevice,
      format: 'rgba8unorm-srgb',
      alphaMode: 'opaque',
      usage: 0x10,
    });
    const descriptor = (configure.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(descriptor).not.toHaveProperty('viewFormats');
  });

  it('uses the capability gate when WebGL2 reports a translated storage limit', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = { configure } as unknown as RhiCanvasContext;
    const webGlDevice = {
      limits: { maxStorageBuffersPerShaderStage: 8 },
      caps: { backendKind: 'wgpu-webgl2', storageBuffer: false },
    } as unknown as RhiDevice;

    const result = configureSurface(context, webGlDevice, 'rgba8unorm', 'rgba8unorm-srgb');

    expect(result.ok).toBe(true);
    expect(configure).toHaveBeenCalledWith({
      device: webGlDevice,
      format: 'rgba8unorm-srgb',
      alphaMode: 'opaque',
      usage: 0x10,
    });
    const descriptor = (configure.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(descriptor).not.toHaveProperty('viewFormats');
  });
});

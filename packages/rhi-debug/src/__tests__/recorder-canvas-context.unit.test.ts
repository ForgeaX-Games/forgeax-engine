import type {
  CanvasConfiguration,
  RhiCanvasContext,
  RhiDevice,
  RhiInstance,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { createRecorderProxy, type RecordableBackend } from '../recorder/proxy';

function backend(acquireCanvasContext: ReturnType<typeof vi.fn>): RecordableBackend {
  return {
    rhi: {
      requestAdapter: vi.fn(),
      acquireCanvasContext,
    } as unknown as RhiInstance & RecordableBackend['rhi'],
    createShaderModule: vi.fn(),
  };
}

describe('recorder canvas context device identity', () => {
  it('unwraps the recorder device before forwarding canvas configure', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = {
      configure,
      unconfigure: vi.fn(),
      getConfiguration: vi.fn(),
      getCurrentTexture: vi.fn(),
    } as unknown as RhiCanvasContext;
    const acquireCanvasContext = vi.fn(() => ok(context));
    const originalDevice = { caps: {} } as unknown as RhiDevice;
    const recorderDevice = { _realDevice: originalDevice } as unknown as RhiDevice;
    const proxy = createRecorderProxy(backend(acquireCanvasContext));

    const acquired = proxy.backend.rhi.acquireCanvasContext?.({} as HTMLCanvasElement);
    expect(acquired?.ok).toBe(true);
    if (!acquired?.ok) return;

    const configuration = {
      device: recorderDevice,
      format: 'bgra8unorm',
    } as CanvasConfiguration;
    expect(acquired.value.configure(configuration)).toEqual(ok(undefined));
    expect(acquireCanvasContext).toHaveBeenCalledOnce();
    expect(configure).toHaveBeenCalledWith({
      ...configuration,
      device: originalDevice,
    });
  });

  it('preserves a native device when no recorder identity is present', () => {
    const configure = vi.fn(() => ok(undefined));
    const context = {
      configure,
      unconfigure: vi.fn(),
      getConfiguration: vi.fn(),
      getCurrentTexture: vi.fn(),
    } as unknown as RhiCanvasContext;
    const proxy = createRecorderProxy(backend(vi.fn(() => ok(context))));
    const nativeDevice = { caps: {} } as unknown as RhiDevice;
    const acquired = proxy.backend.rhi.acquireCanvasContext?.({} as HTMLCanvasElement);
    if (!acquired?.ok) throw new Error('canvas context acquisition failed');

    acquired.value.configure({ device: nativeDevice, format: 'bgra8unorm' } as CanvasConfiguration);
    expect(configure).toHaveBeenCalledWith({ device: nativeDevice, format: 'bgra8unorm' });
  });
});

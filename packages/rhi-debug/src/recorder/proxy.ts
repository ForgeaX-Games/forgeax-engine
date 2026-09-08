import type { RhiCanvasContext, RhiDevice, RhiError, RhiInstance } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import {
  type CreateShaderModuleFn,
  type DebugRhiInstance,
  wrap,
  wrapCreateShaderModule,
} from '../recorder';

export interface RecordableBackend {
  readonly rhi: RhiInstance & {
    readonly acquireCanvasContext?: (
      canvas: HTMLCanvasElement | OffscreenCanvas,
    ) => Result<RhiCanvasContext, RhiError>;
  };
  readonly createShaderModule: CreateShaderModuleFn;
}

export interface RecorderBackend extends RecordableBackend {
  readonly unwrapDeviceForSurface: (device: RhiDevice) => Result<RhiDevice, RhiDebugError>;
}

export interface RecorderProxy {
  readonly backend: RecorderBackend;
  readonly recorder: DebugRhiInstance;
}

export function createRecorderProxy(backend: RecordableBackend): RecorderProxy {
  const recorder = wrap(backend.rhi);
  const wrappedCreateShaderModule = wrapCreateShaderModule(backend.createShaderModule, recorder);
  const acquireCanvasContext = backend.rhi.acquireCanvasContext;
  // Runtime's explicit-RHI seam receives the wrapped singleton as one value.
  // Keep the standalone shader factory enumerable on that value so the
  // renderer can preserve the complete typed backend pack after capture
  // attachment; the public RhiInstance contract remains unchanged.
  const rhi: RecordableBackend['rhi'] & { readonly createShaderModule: CreateShaderModuleFn } = {
    requestAdapter: recorder.requestAdapter.bind(recorder),
    createShaderModule: wrappedCreateShaderModule,
    ...(acquireCanvasContext === undefined
      ? {}
      : { acquireCanvasContext: acquireCanvasContext.bind(backend.rhi) }),
  };
  const wrappedBackend: RecorderBackend = {
    rhi,
    createShaderModule: wrappedCreateShaderModule,
    unwrapDeviceForSurface(device) {
      const raw = (device as RhiDevice & { readonly _realDevice?: RhiDevice })._realDevice;
      if (raw !== undefined) return ok(raw);
      return err(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: 'the recorder backend does not expose a surface device resolver',
        }),
      );
    },
  };
  return { backend: wrappedBackend, recorder };
}

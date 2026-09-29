import type { RhiCanvasContext, RhiDevice, RhiError, RhiInstance } from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import {
  type CreateShaderModuleFn,
  type CreateShaderModuleImmediateFn,
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
  /** Optional synchronous factory retained for render's first-use path. */
  readonly createShaderModuleImmediate?: CreateShaderModuleImmediateFn;
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
  const originalCreateShaderModuleImmediate = backend.createShaderModuleImmediate;
  const wrappedCreateShaderModuleImmediate =
    originalCreateShaderModuleImmediate === undefined
      ? undefined
      : (device: RhiDevice, desc: { code: string; label?: string | undefined }) => {
          const realDevice =
            (device as RhiDevice & { readonly _realDevice?: RhiDevice })._realDevice ?? device;
          const result = originalCreateShaderModuleImmediate(realDevice, desc);
          if (!result.ok) return result;
          const hId = recorder.pushExternalCreateEvent(result.value, 'shaderModule', {
            kind: 'createShaderModule',
            handleId: '' as import('../types').HandleId,
            wgslCode: desc.code,
          });
          recorder.registerShaderModule(result.value, hId);
          return result;
        };
  const acquireCanvasContext = backend.rhi.acquireCanvasContext;
  // Runtime's explicit-RHI seam receives the wrapped singleton as one value.
  // Keep the standalone shader factory enumerable on that value so the
  // renderer can preserve the complete typed backend pack after capture
  // attachment; the public RhiInstance contract remains unchanged.
  const rhi: RecordableBackend['rhi'] & {
    readonly createShaderModule: CreateShaderModuleFn;
    readonly createShaderModuleImmediate?: CreateShaderModuleImmediateFn;
  } = {
    requestAdapter: recorder.requestAdapter.bind(recorder),
    createShaderModule: wrappedCreateShaderModule,
    ...(wrappedCreateShaderModuleImmediate === undefined
      ? {}
      : { createShaderModuleImmediate: wrappedCreateShaderModuleImmediate }),
    ...(acquireCanvasContext === undefined
      ? {}
      : {
          acquireCanvasContext(canvas) {
            const result = acquireCanvasContext.call(backend.rhi, canvas);
            if (!result.ok) return result;
            const context = result.value;
            // rhi-webgpu's canvas shim translates the forgeax RhiDevice to the
            // native GPUDevice through its own WeakMap. The recorder device is
            // an intentional proxy, so passing it directly makes configure()
            // reject with a foreign-device error before the first frame. Keep
            // the context owned by the selected backend, but unwrap only the
            // device argument at this boundary; all resource calls continue to
            // flow through the recorder device and remain capturable.
            return ok({
              ...context,
              configure(configuration) {
                const device = (
                  configuration.device as RhiDevice & {
                    readonly _realDevice?: RhiDevice;
                  }
                )._realDevice;
                return context.configure({
                  ...configuration,
                  ...(device === undefined ? {} : { device }),
                });
              },
            });
          },
        }),
  };
  const wrappedBackend: RecorderBackend = {
    rhi,
    createShaderModule: wrappedCreateShaderModule,
    ...(wrappedCreateShaderModuleImmediate === undefined
      ? {}
      : { createShaderModuleImmediate: wrappedCreateShaderModuleImmediate }),
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

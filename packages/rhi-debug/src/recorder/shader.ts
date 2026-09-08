// @forgeax/engine-rhi-debug/src/recorder/shader -- standalone shader factory proxy.

import type { Result, RhiDevice, ShaderModule } from '@forgeax/engine-rhi';
import type { HandleId } from '../types';
import type { CreateShaderModuleFn, DebugRhiInstance } from './core';

export function wrapCreateShaderModule(
  originalFn: CreateShaderModuleFn,
  debugInst: DebugRhiInstance,
): CreateShaderModuleFn {
  return async function wrappedCreateShaderModule(
    device: RhiDevice,
    desc: { code: string; label?: string | undefined },
  ): Promise<Result<ShaderModule, import('@forgeax/engine-rhi').RhiError>> {
    // The renderer threads the proxied RhiDevice (from proxyDevice()) here, but
    // engine-rhi-webgpu's createShaderModule reverse-looks-up the GPUDevice via
    // a WeakMap keyed on the RhiDevice that makeRhiDevice registered. The proxy
    // is a different JS object, so WeakMap.get(proxy) is undefined and the real
    // fn returns shader-compile-failed ("unregistered RhiDevice"). Unwrap the
    // proxy to the registered device via the _realDevice escape hatch that
    // proxyDevice exposes for exactly this purpose.
    const realDevice = (device as RhiDevice & { _realDevice?: RhiDevice })._realDevice ?? device;
    const result = await originalFn(realDevice, desc);
    if (!result.ok) return result;

    // I-12 (round 1 implement-review) fix: route the createShaderModule
    // event through the same `pushExternalEvent` helper that wraps the
    // internal `pushEvent` (and therefore the `_skipRecord` + state-machine
    // guard). The previous `(events as RhiCallEvent[]).push(...)` cast
    // bypassed those guards — recorder-internal RHI calls during shader
    // construction would have self-polluted the tape.
    const hId = debugInst.pushExternalCreateEvent(result.value, 'shaderModule', {
      kind: 'createShaderModule',
      handleId: '' as HandleId,
      wgslCode: desc.code,
    });
    // Register the shader module handle in the recorder's handleMap so
    // downstream pipeline events (createRenderPipeline / createComputePipeline)
    // can resolve the handleId via getHandleId. Required for cross-device
    // replay: the tape's pipeline desc carries live GPU module objects which
    // are device-bound, so the replayer must swap them with re-created shader
    // modules from the handleMap using the handleId.
    debugInst.registerShaderModule(result.value, hId);

    return result;
  };
}

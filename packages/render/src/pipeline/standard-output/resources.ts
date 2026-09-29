import { err, ok, type Result, RhiError } from '@forgeax/engine-rhi';
import { toShared } from '@forgeax/engine-types';
import type { RenderResourceScope } from '../../publication/resource-scope';
import type { RenderFrameState } from '../../record/frame-snapshot';
import type { RenderSystemInternals } from '../../record/render-context';
import type { CameraSnapshot } from '../../render-contract';
import {
  createAutoExposureGpuResources,
  retireAutoExposureGpuResources,
} from './auto-exposure/gpu';
import { resetAutoExposureState } from './auto-exposure/state';
import { prepareStandardLutGpu } from './lut-gpu';
import { recordStandardLutFailure, resetStandardLutState } from './lut-state';

/** Ordinary frames and detached recovery graphs prepare the same output resources. */
export function prepareStandardOutputResources(
  state: RenderFrameState,
  internals: RenderSystemInternals,
  camera: CameraSnapshot | undefined,
  world: RenderResourceScope,
): Result<void, RhiError> {
  const output = camera?.output;
  if (output?.exposure.kind === 'auto') {
    const pending = state.pendingAutoExposureGpuResources;
    if (pending !== undefined && pending.device !== internals.device) {
      retireAutoExposureGpuResources(pending);
      state.pendingAutoExposureGpuResources = undefined;
    }
    if (
      state.autoExposureGpuResources?.device !== internals.device &&
      state.pendingAutoExposureGpuResources?.device !== internals.device
    ) {
      const resources = createAutoExposureGpuResources(
        internals.device,
        state.compiledFrameGraphGeneration,
      );
      if (!resources.ok) {
        return err(
          new RhiError({
            code: 'webgpu-runtime-error',
            expected: 'auto-exposure GPU resources are prepared before graph build',
            hint: 'inspect the device capability and retry the current camera generation',
            detail: {
              error: { code: 'auto-exposure-prepare-failed', message: String(resources.error) },
            },
          }),
        );
      }
      state.pendingAutoExposureGpuResources = resources.value;
    }
  } else {
    if (state.pendingAutoExposureGpuResources !== undefined)
      retireAutoExposureGpuResources(state.pendingAutoExposureGpuResources);
    if (state.autoExposureGpuResources !== undefined)
      retireAutoExposureGpuResources(state.autoExposureGpuResources);
    state.pendingAutoExposureGpuResources = undefined;
    state.autoExposureGpuResources = undefined;
  }
  if (output !== undefined && output.colorLutStrength > 0) {
    const lut = prepareStandardLutGpu({
      world,
      handle: toShared<'TextureAsset'>(output.colorLut),
      strength: output.colorLutStrength,
      assets: internals.assets,
      gpuStore: internals.gpuStore,
      device: internals.device,
    });
    if (!lut.ok) {
      state.standardLutState = recordStandardLutFailure(state.standardLutState, lut.error);
      state.pendingStandardLutGpuResources = undefined;
      return err(
        new RhiError({
          code: 'webgpu-runtime-error',
          expected: 'the authored LUT resolves, is resident, and binds on the live device',
          hint: 'inspect the LUT asset GUID and live capability before retrying',
          detail: {
            error: {
              code: lut.error.code,
              message: `${lut.error.expected}; ${lut.error.hint}; ${JSON.stringify(lut.error.detail)}`,
            },
          },
        }),
      );
    }
    const accepted = state.standardLutGpuResources;
    if (
      accepted?.sourceKey !== lut.value.sourceKey ||
      accepted.texture !== lut.value.texture ||
      accepted.strength !== lut.value.strength
    ) {
      state.pendingStandardLutGpuResources = lut.value;
    }
  } else {
    state.pendingStandardLutGpuResources = undefined;
    state.standardLutGpuResources = undefined;
  }
  return ok(undefined);
}

/** Drop lost-device handles without destroying them; retain only reset CPU/LKG facts. */
export function resetStandardOutputForDeviceLoss(
  state: RenderFrameState,
  deviceEpoch: number,
): void {
  if (state.autoExposureState !== undefined) {
    state.autoExposureState = resetAutoExposureState(state.autoExposureState, 'device-lost', {
      targetGeneration: state.autoExposureState.targetGeneration + 1,
      deviceEpoch,
    });
  }
  state.standardLutState = resetStandardLutState(state.standardLutState, 'device-recovered', {
    targetGeneration: state.standardLutState.targetGeneration + 1,
    deviceEpoch,
  });
  state.pendingAutoExposureState = undefined;
  state.pendingStandardLutState = undefined;
  state.pendingAutoExposureGpuResources = undefined;
  state.autoExposureGpuResources = undefined;
  state.pendingStandardLutGpuResources = undefined;
  state.standardLutGpuResources = undefined;
}

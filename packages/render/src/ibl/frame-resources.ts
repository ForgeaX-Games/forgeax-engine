import type { RhiError } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { RenderSystemRuntime } from '../record/render-context';
import type { SkylightSnapshot } from '../render-system-extract';
import { getOrCreateIblCache } from './IblPipelineCache';
import type { SkylightBindGroupResources, SkylightFallback } from './skylight-bind-group';

const EMPTY_SKYLIGHT = new Float32Array([0, 0, 0, 0, 0, 0, 0, 1]);

/** Standard and feature materials consume the same generation-owned environment. */
export function resolveFrameSkylightResources(
  runtime: Pick<RenderSystemRuntime, 'device' | 'deviceScope'>,
  fallback: SkylightFallback,
  skylight: SkylightSnapshot | undefined,
): Result<SkylightBindGroupResources, RhiError> {
  const payload =
    skylight === undefined
      ? EMPTY_SKYLIGHT
      : new Float32Array([skylight.intensity, ...skylight.color, ...skylight.rotation]);
  const uploaded = runtime.device.queue.writeBuffer(fallback.intensityBuffer, 0, payload);
  if (!uploaded.ok) return uploaded;
  const cache = skylight === undefined ? undefined : getOrCreateIblCache(runtime.deviceScope);
  const resident =
    cache?.irradianceView !== undefined &&
    cache.prefilterView !== undefined &&
    cache.brdfLutView !== undefined
      ? cache
      : undefined;
  return ok({
    irradianceView: resident?.irradianceView ?? fallback.irradianceView,
    irradianceSampler: fallback.sampler,
    prefilterView: resident?.prefilterView ?? fallback.prefilterView,
    prefilterSampler: fallback.sampler,
    brdfLutView: resident?.brdfLutView ?? fallback.brdfLutView,
    intensityBuffer: fallback.intensityBuffer,
  });
}

import { type Buffer, RhiError } from '@forgeax/engine-rhi';
import { GpuBuffer } from '../gpu-resource';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../gpu-usage';
import type { InstanceBufferCacheEntry } from '../instance-buffer-cache';
import type { SpriteInstancesSnapshot } from '../render-system-extract';
import { worldEntityKey } from './frame-snapshot';
import type { _InternalRenderPipelineContext } from './render-context';

export type { SpriteInstancesSnapshot } from '../render-system-extract';

/**
 * Build the interleaved sprite instance payload consumed by this record owner.
 * The extract stage validates the two packed arrays before they reach this
 * function, so the record path has one source of count-mismatch errors.
 */
export function interleaveSpriteInstanceBuffer(
  transforms: Float32Array,
  regions: Float32Array,
  includePrevious = false,
): Float32Array {
  const count = transforms.length / 16;
  const stride = includePrevious ? 36 : 20;
  const regionOffset = includePrevious ? 32 : 16;
  const out = new Float32Array(count * stride);
  for (let i = 0; i < count; i++) {
    const dstBase = i * stride;
    const transformBase = i * 16;
    const regionBase = i * 4;
    for (let k = 0; k < 16; k++) out[dstBase + k] = transforms[transformBase + k] ?? 0;
    if (includePrevious) {
      for (let k = 0; k < 16; k++) {
        out[dstBase + 16 + k] = transforms[transformBase + k] ?? 0;
      }
    }
    for (let k = 0; k < 4; k++) {
      out[dstBase + regionOffset + k] = regions[regionBase + k] ?? 0;
    }
  }
  return out;
}

/**
 * Check whether the existing per-entity sprite buffer still matches the
 * extract snapshot and interleaved byte count.
 */
export function spriteInstancesCacheHit(
  entry: InstanceBufferCacheEntry | undefined,
  snapshot: SpriteInstancesSnapshot,
  requestedBytes: number,
): boolean {
  return (
    entry !== undefined &&
    entry.uploadedArchVersion === snapshot.archVersion &&
    entry.uploadedByteLength === requestedBytes
  );
}

/**
 * feat-20260704 M3/w19: resolve the interleaved SpriteInstances (@group(3))
 * buffer + instanceCount for a sprite entity in the LDR blend sub-pass,
 * extracted verbatim from recordSpriteEntityDraws. Uploads the interleaved
 * mat4 + per-instance UV region transforms (cache-keyed on the snapshot); on
 * over-cap fires the structured limit-exceeded error and leaves the passed-in
 * fallback buffer/count. Returns the resolved (or unchanged) buffer + count.
 *
 * @internal
 */
export function resolveSpriteInstancesBuffer(
  c: Pick<_InternalRenderPipelineContext, 'runtime' | 'frameState'>,
  spriteEntry: _InternalRenderPipelineContext['validatedOrdered'][number],
  fallbackBuffer: Buffer,
  fallbackCount: number,
): { buffer: Buffer; count: number } {
  const { runtime, frameState } = c;
  let buffer = fallbackBuffer;
  let count = fallbackCount;
  const spriteInstancesSnap: SpriteInstancesSnapshot | undefined =
    spriteEntry.source.spriteInstances;
  if (spriteInstancesSnap !== undefined) {
    if (spriteInstancesSnap.instanceCount === 0) return { buffer, count: 0 };
    const uniformFallback = runtime.device.caps.storageBuffer === false;
    const interleaved = interleaveSpriteInstanceBuffer(
      spriteInstancesSnap.transforms,
      spriteInstancesSnap.regions,
      !uniformFallback,
    );
    const requestedBytes = interleaved.byteLength;
    const cap = runtime.device.limits.maxStorageBufferBindingSize;
    if (typeof cap === 'number' && requestedBytes > cap) {
      runtime.errorRegistry.fire(
        new RhiError({
          code: 'limit-exceeded',
          expected: `requestedBytes (${requestedBytes}) <= maxStorageBufferBindingSize (${cap})`,
          hint: 'reduce SpriteInstances instance count to fit within device.limits.maxStorageBufferBindingSize (144 bytes per instance: current mat4 64B + previous mat4 64B + region 16B)',
          detail: {
            maxStorageBufferBindingSize: cap,
            requestedBytes,
          },
        }),
      );
    } else {
      const cachedSpriteInst = frameState.instanceBuffers.get(
        worldEntityKey(spriteEntry.source.worldId, spriteInstancesSnap.cacheKey),
      );
      let activeSpriteInst: InstanceBufferCacheEntry | null = null;
      if (spriteInstancesCacheHit(cachedSpriteInst, spriteInstancesSnap, requestedBytes)) {
        activeSpriteInst = cachedSpriteInst ?? null;
      } else if (requestedBytes > 0) {
        const bufRes = runtime.device.createBuffer({
          size: requestedBytes,
          usage:
            (uniformFallback ? GPU_BUFFER_USAGE_UNIFORM : GPU_BUFFER_USAGE_STORAGE) |
            GPU_BUFFER_USAGE_COPY_DST,
          mappedAtCreation: false,
        });
        if (!bufRes.ok) {
          runtime.errorRegistry.fire(bufRes.error);
        } else {
          if (cachedSpriteInst !== undefined && !cachedSpriteInst.buffer.isDestroyed) {
            const r = cachedSpriteInst.buffer.destroy();
            if (!r.ok) runtime.errorRegistry.fire(r.error);
          }
          const newBuf = new GpuBuffer(runtime.device, bufRes.value);
          activeSpriteInst = {
            buffer: newBuf,
            uploadedArchVersion: spriteInstancesSnap.archVersion,
            uploadedByteLength: requestedBytes,
          };
          frameState.instanceBuffers.set(
            worldEntityKey(spriteEntry.source.worldId, spriteInstancesSnap.cacheKey),
            activeSpriteInst,
          );
        }
      }
      if (activeSpriteInst !== null && requestedBytes > 0) {
        const writeRes = runtime.device.queue.writeBuffer(
          activeSpriteInst.buffer.handle,
          0,
          interleaved,
        );
        if (!writeRes.ok) {
          runtime.errorRegistry.fire(writeRes.error);
        } else {
          buffer = activeSpriteInst.buffer.handle;
          count = spriteInstancesSnap.instanceCount;
        }
      }
    }
  }
  return { buffer, count };
}

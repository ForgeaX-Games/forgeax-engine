// @forgeax/engine-rhi-null/src/queue - headless command queue.
//
// All write* methods are no-ops returning ok; submit records nothing and
// returns ok (AC-12). onSubmittedWorkDone resolves immediately so headless
// read-back idioms never hang (the real GPU resolves after work completes; with
// no pending work the headless backend resolves synchronously).
//
// Related: requirements AC-12 (submit ok + onSubmittedWorkDone resolves);
// research Finding A1 row 4.

import type {
  Buffer,
  CommandBuffer,
  Result,
  RhiError as RhiErrorType,
  RhiQueue,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';

/** Headless no-op queue. */
export class RhiNullQueue implements RhiQueue {
  writeBuffer(
    _buffer: Buffer,
    _bufferOffset: number,
    _data: ArrayBufferView | ArrayBuffer,
    _dataOffset?: number | undefined,
    _size?: number | undefined,
  ): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  writeTexture(
    _destination: Pick<GPUTexelCopyTextureInfo, 'texture' | 'mipLevel' | 'origin' | 'aspect'>,
    _data: ArrayBufferView | ArrayBuffer,
    _dataLayout: Pick<GPUTexelCopyBufferLayout, 'offset' | 'bytesPerRow' | 'rowsPerImage'>,
    _size: GPUExtent3DStrict,
  ): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  copyExternalImageToTexture(
    _source: Pick<GPUCopyExternalImageSourceInfo, 'source' | 'origin' | 'flipY'>,
    _destination: Pick<
      GPUCopyExternalImageDestInfo,
      'texture' | 'mipLevel' | 'origin' | 'aspect' | 'colorSpace' | 'premultipliedAlpha'
    >,
    _copySize: GPUExtent3DStrict,
  ): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  submit(_commandBuffers: readonly CommandBuffer[]): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  // forgeax-async-whitelist: dom-native — spec `GPUQueue.onSubmittedWorkDone`
  // never rejects. The headless backend has no pending GPU work, so it resolves
  // immediately (AC-12: read-back idioms must not hang).
  onSubmittedWorkDone(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

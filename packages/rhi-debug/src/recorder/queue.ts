// @forgeax/engine-rhi-debug/src/recorder/queue -- queue proxy owner.

import type { Buffer, CommandBuffer, RhiQueue } from '@forgeax/engine-rhi';
import type { RhiCallEventWriteTexture } from '../types';
import type { RecorderInternal } from './core';
import { getHandleId, pushEvent, shouldRecord, storeBlob } from './core';

export function createQueueProxy(s: RecorderInternal, realQueue: RhiQueue): RhiQueue {
  return {
    writeBuffer(
      buffer: Buffer,
      bufferOffset: number,
      data: ArrayBufferView | ArrayBuffer,
      dataOffset?: number,
      size?: number,
    ) {
      // Idle fast-path: when not recording, skip getHandleId + slice + the
      // storeBlob hash-and-double-copy entirely (they would only feed a
      // pushEvent that the state gate drops, and blobPool is reset on arm()).
      // Same-condition-as-pushEvent, so a recording call still records.
      if (!shouldRecord(s)) {
        return realQueue.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
      }
      const hId = getHandleId(s, buffer as object, 'buffer');
      const raw = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      const sz = size ?? raw.byteLength - (dataOffset ?? 0);
      const slice = raw.slice(dataOffset ?? 0, (dataOffset ?? 0) + sz);
      const dataHash = storeBlob(s, slice.buffer as ArrayBuffer);

      pushEvent(s, {
        kind: 'writeBuffer',
        handleId: hId,
        bufferOffset,
        dataHash,
        size: sz,
      });
      return realQueue.writeBuffer(buffer, bufferOffset, data, dataOffset, size);
    },

    writeTexture(destination, data, dataLayout, copySize) {
      // Idle fast-path (see writeBuffer): skip storeBlob hash+copy when the
      // recorded event would be dropped anyway.
      if (!shouldRecord(s)) {
        return realQueue.writeTexture(destination, data, dataLayout, copySize);
      }
      const hId = getHandleId(s, destination.texture as object, 'texture');
      const raw = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data as ArrayBuffer);
      const dataHash = storeBlob(s, raw.buffer as ArrayBuffer);

      pushEvent(s, {
        kind: 'writeTexture',
        destination: {
          textureHandleId: hId,
          mipLevel: destination.mipLevel,
          origin: destination.origin,
          aspect: destination.aspect,
        },
        dataHash,
        dataLayout: {
          offset: dataLayout.offset,
          bytesPerRow: dataLayout.bytesPerRow,
          rowsPerImage: dataLayout.rowsPerImage,
        },
        size: copySize,
      } as RhiCallEventWriteTexture);
      return realQueue.writeTexture(destination, data, dataLayout, copySize);
    },

    copyExternalImageToTexture(source, destination, copySize) {
      if (!shouldRecord(s)) {
        return realQueue.copyExternalImageToTexture(source, destination, copySize);
      }
      const hId = getHandleId(s, destination.texture as object, 'texture');
      pushEvent(s, {
        kind: 'copyExternalImageToTexture',
        source: { origin: source.origin, flipY: source.flipY },
        destination: {
          textureHandleId: hId,
          mipLevel: destination.mipLevel,
          origin: destination.origin,
          aspect: destination.aspect,
          colorSpace: destination.colorSpace,
          premultipliedAlpha: destination.premultipliedAlpha,
        },
        copySize,
      });
      return realQueue.copyExternalImageToTexture(source, destination, copySize);
    },

    submit(commandBuffers: readonly CommandBuffer[]) {
      if (!shouldRecord(s)) {
        return realQueue.submit(commandBuffers);
      }
      const cmdHandleIds = commandBuffers.map((cb) =>
        getHandleId(s, cb as object, 'commandBuffer'),
      );
      pushEvent(s, { kind: 'submit', cmdHandleIds });
      return realQueue.submit(commandBuffers);
    },

    onSubmittedWorkDone() {
      return realQueue.onSubmittedWorkDone();
    },
  };
}

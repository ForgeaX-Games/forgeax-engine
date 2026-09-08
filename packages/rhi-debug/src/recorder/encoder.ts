// @forgeax/engine-rhi-debug/src/recorder/encoder -- command encoder proxy owner.

import type {
  Buffer,
  ComputePassDescriptor,
  RenderPassDescriptor,
  RhiCommandEncoder,
} from '@forgeax/engine-rhi';
import type { HandleId } from '../types';
import type { RecorderInternal } from './core';
import { allocHandleId, getHandleId, pushEvent } from './core';
import { createComputePassProxy, createRenderPassProxy } from './pass';

export function createCommandEncoderProxy(
  s: RecorderInternal,
  realEnc: RhiCommandEncoder,
  cmdHId: HandleId,
): RhiCommandEncoder {
  return {
    beginRenderPass(desc: RenderPassDescriptor) {
      const passHId = allocHandleId('renderPass');
      // I-2 fix-up (round 1, dawn smoke): walk colorAttachments +
      // depthStencilAttachment to extract the textureView handleIds
      // recorded under createTextureView. Without this the replayer
      // would dereference the original GPUTextureView brand directly,
      // which fails on a fresh device (cross-device GPU object reuse).
      const colorAttachmentViewHandleIds: (HandleId | undefined)[] = [];
      const colorAttachmentResolveTargetHandleIds: (HandleId | undefined)[] = [];
      for (const att of desc.colorAttachments) {
        if (att === null || att === undefined) {
          colorAttachmentViewHandleIds.push(undefined);
          colorAttachmentResolveTargetHandleIds.push(undefined);
        } else {
          const view = att.view;
          const id =
            view !== undefined && view !== null ? s.handleMap.get(view as object) : undefined;
          colorAttachmentViewHandleIds.push(id);
          const resolveTarget = att.resolveTarget;
          const resolveTargetId =
            resolveTarget !== undefined && resolveTarget !== null
              ? s.handleMap.get(resolveTarget as object)
              : undefined;
          colorAttachmentResolveTargetHandleIds.push(resolveTargetId);
        }
      }
      let depthStencilViewHandleId: HandleId | undefined;
      if (desc.depthStencilAttachment !== undefined) {
        const dsView = desc.depthStencilAttachment.view;
        if (dsView !== undefined && dsView !== null) {
          depthStencilViewHandleId = s.handleMap.get(dsView as object);
        }
      }
      pushEvent(s, {
        kind: 'beginRenderPass',
        cmdHandleId: cmdHId,
        passHandleId: passHId,
        desc: {
          colorAttachments: Array.from(desc.colorAttachments).map((attachment) =>
            attachment === null || attachment === undefined ? attachment : { ...attachment },
          ),
          ...(desc.depthStencilAttachment === undefined
            ? {}
            : { depthStencilAttachment: { ...desc.depthStencilAttachment } }),
          ...(desc.occlusionQuerySet === undefined
            ? {}
            : { occlusionQuerySet: desc.occlusionQuerySet }),
          ...(desc.timestampWrites === undefined ? {} : { timestampWrites: desc.timestampWrites }),
          ...(desc.maxDrawCount === undefined ? {} : { maxDrawCount: desc.maxDrawCount }),
        },
        colorAttachmentViewHandleIds,
        colorAttachmentResolveTargetHandleIds,
        depthStencilViewHandleId,
      });
      const realPass = realEnc.beginRenderPass(desc);
      return createRenderPassProxy(s, realPass, passHId);
    },
    beginComputePass(desc?: ComputePassDescriptor | undefined) {
      const passHId = allocHandleId('computePass');
      pushEvent(s, {
        kind: 'beginComputePass',
        cmdHandleId: cmdHId,
        passHandleId: passHId,
        desc: desc as Partial<GPUComputePassDescriptor> | undefined,
      });
      const realPass = realEnc.beginComputePass(desc);
      return createComputePassProxy(s, realPass, passHId);
    },
    // Passthrough copy/clear methods (event recording added where types permit)
    copyBufferToBuffer(...args: unknown[]) {
      // Overloaded: 3-arg or 5-arg
      if (typeof args[1] === 'number') {
        // 5-arg form: (source, sourceOffset, destination, destinationOffset, size)
        const sourceId = getHandleId(s, args[0] as object, 'buffer');
        const destinationId = getHandleId(s, args[2] as object, 'buffer');
        pushEvent(s, {
          kind: 'copyBufferToBuffer',
          cmdHandleId: cmdHId,
          sourceHandleId: sourceId,
          sourceOffset: args[1] as number,
          destinationHandleId: destinationId,
          destinationOffset: args[3] as number,
          size: args[4] as number,
        });
        (realEnc.copyBufferToBuffer as (...args: unknown[]) => void)(...args);
      } else {
        // 3-arg form: (source, destination, size?)
        const sourceId = getHandleId(s, args[0] as object, 'buffer');
        const destinationId = getHandleId(s, args[1] as object, 'buffer');
        const size = args[2] as number | undefined;
        pushEvent(s, {
          kind: 'copyBufferToBuffer',
          cmdHandleId: cmdHId,
          sourceHandleId: sourceId,
          sourceOffset: 0,
          destinationHandleId: destinationId,
          destinationOffset: 0,
          size: (size ?? 0) as number,
        });
        realEnc.copyBufferToBuffer(args[0] as Buffer, args[1] as Buffer, size);
      }
    },
    copyBufferToTexture(source, destination, copySize) {
      const bufId = getHandleId(s, (source as { buffer: object }).buffer as object, 'buffer');
      const texId = getHandleId(
        s,
        (destination as { texture: object }).texture as object,
        'texture',
      );
      const dstPayload: Record<string, unknown> = { textureHandleId: texId };
      if (destination.mipLevel !== undefined) dstPayload.mipLevel = destination.mipLevel;
      if (destination.origin !== undefined) dstPayload.origin = destination.origin;
      if (destination.aspect !== undefined) dstPayload.aspect = destination.aspect;
      pushEvent(s, {
        kind: 'copyBufferToTexture',
        cmdHandleId: cmdHId,
        source: {
          bufferHandleId: bufId,
          offset: source.offset ?? 0,
          bytesPerRow: source.bytesPerRow ?? 0,
          rowsPerImage: source.rowsPerImage ?? 0,
        },
        destination: dstPayload as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
          readonly textureHandleId: HandleId;
        },
        copySize,
      });
      realEnc.copyBufferToTexture(source, destination, copySize);
    },
    copyTextureToBuffer(source, destination, copySize) {
      const texId = getHandleId(s, (source as { texture: object }).texture as object, 'texture');
      const bufId = getHandleId(s, (destination as { buffer: object }).buffer as object, 'buffer');
      const srcPayload: Record<string, unknown> = { textureHandleId: texId };
      if (source.mipLevel !== undefined) srcPayload.mipLevel = source.mipLevel;
      if (source.origin !== undefined) srcPayload.origin = source.origin;
      if (source.aspect !== undefined) srcPayload.aspect = source.aspect;
      pushEvent(s, {
        kind: 'copyTextureToBuffer',
        cmdHandleId: cmdHId,
        source: srcPayload as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
          readonly textureHandleId: HandleId;
        },
        destination: {
          bufferHandleId: bufId,
          offset: destination.offset ?? 0,
          bytesPerRow: destination.bytesPerRow ?? 0,
          rowsPerImage: destination.rowsPerImage ?? 0,
        },
        copySize,
      });
      realEnc.copyTextureToBuffer(source, destination, copySize);
    },
    copyTextureToTexture(source, destination, copySize) {
      const srcTexId = getHandleId(s, (source as { texture: object }).texture as object, 'texture');
      const dstTexId = getHandleId(
        s,
        (destination as { texture: object }).texture as object,
        'texture',
      );
      const srcPayload: Record<string, unknown> = { textureHandleId: srcTexId };
      if (source.mipLevel !== undefined) srcPayload.mipLevel = source.mipLevel;
      if (source.origin !== undefined) srcPayload.origin = source.origin;
      if (source.aspect !== undefined) srcPayload.aspect = source.aspect;
      const dstPayload: Record<string, unknown> = { textureHandleId: dstTexId };
      if (destination.mipLevel !== undefined) dstPayload.mipLevel = destination.mipLevel;
      if (destination.origin !== undefined) dstPayload.origin = destination.origin;
      if (destination.aspect !== undefined) dstPayload.aspect = destination.aspect;
      pushEvent(s, {
        kind: 'copyTextureToTexture',
        cmdHandleId: cmdHId,
        source: srcPayload as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
          readonly textureHandleId: HandleId;
        },
        destination: dstPayload as Omit<GPUTexelCopyTextureInfo, 'texture'> & {
          readonly textureHandleId: HandleId;
        },
        copySize,
      });
      realEnc.copyTextureToTexture(source, destination, copySize);
    },
    clearBuffer(buffer, offset, size) {
      const bufId = getHandleId(s, buffer as object, 'buffer');
      pushEvent(s, {
        kind: 'clearBuffer',
        cmdHandleId: cmdHId,
        handleId: bufId,
        offset,
        size,
      });
      realEnc.clearBuffer(buffer, offset, size);
    },
    resolveQuerySet(querySet, firstQuery, queryCount, destination, destinationOffset) {
      return realEnc.resolveQuerySet(
        querySet,
        firstQuery,
        queryCount,
        destination,
        destinationOffset,
      );
    },
    writeTimestamp(querySet, queryIndex) {
      realEnc.writeTimestamp(querySet, queryIndex);
    },
    pushDebugGroup(groupLabel) {
      pushEvent(s, { kind: 'pushDebugGroup', cmdHandleId: cmdHId, groupLabel });
      realEnc.pushDebugGroup(groupLabel);
    },
    popDebugGroup() {
      pushEvent(s, { kind: 'popDebugGroup', cmdHandleId: cmdHId });
      realEnc.popDebugGroup();
    },
    insertDebugMarker(markerLabel) {
      pushEvent(s, { kind: 'insertDebugMarker', cmdHandleId: cmdHId, markerLabel });
      realEnc.insertDebugMarker(markerLabel);
    },
    finish() {
      pushEvent(s, { kind: 'finish', cmdHandleId: cmdHId });
      const res = realEnc.finish();
      // I-2 fix-up (round 1, dawn smoke handle-graph integrity):
      // alias the resulting CommandBuffer object to the encoder's
      // cmdHandleId so subsequent queue.submit() handle lookups resolve
      // to the SAME id that the createCommandEncoder/finish event pair
      // declared. Without this, submit would register a fresh handleId
      // for the CommandBuffer object and the tape's handle graph
      // integrity check would reject the tape on deserialize.
      if (res.ok) {
        s.handleMap.set(res.value as object, cmdHId);
      }
      return res;
    },
  };
}

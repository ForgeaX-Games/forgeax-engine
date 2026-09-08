// @forgeax/engine-rhi-debug/src/recorder/pass -- render/compute pass proxy owners.

import type {
  ComputePipeline,
  RenderPipeline,
  RhiComputePassEncoder,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import type { HandleId } from '../types';
import type { RecorderInternal } from './core';
import { getHandleId, pushEvent } from './core';

export function createRenderPassProxy(
  s: RecorderInternal,
  realPass: RhiRenderPassEncoder,
  passHId: HandleId,
): RhiRenderPassEncoder {
  return {
    setPipeline(pipeline: RenderPipeline) {
      const pid = getHandleId(s, pipeline as object, 'renderPipeline');
      pushEvent(s, { kind: 'setPipeline', passHandleId: passHId, pipelineHandleId: pid });
      realPass.setPipeline(pipeline);
    },
    setVertexBuffer(slot, buffer, offset, size) {
      const bid = getHandleId(s, buffer as object, 'buffer');
      pushEvent(s, {
        kind: 'setVertexBuffer',
        passHandleId: passHId,
        slot,
        bufferHandleId: bid,
        offset,
        size,
      });
      realPass.setVertexBuffer(slot, buffer, offset, size);
    },
    setIndexBuffer(buffer, format, offset, size) {
      const bid = getHandleId(s, buffer as object, 'buffer');
      pushEvent(s, {
        kind: 'setIndexBuffer',
        passHandleId: passHId,
        bufferHandleId: bid,
        format,
        offset,
        size,
      });
      realPass.setIndexBuffer(buffer, format, offset, size);
    },
    setBindGroup(index, bindGroup, ...rest: unknown[]) {
      const bgid = getHandleId(s, bindGroup as object, 'bindGroup');
      let dynOffsets: readonly number[] | undefined;
      if (rest[0] instanceof Uint32Array) {
        dynOffsets = Array.from(rest[0] as Uint32Array);
        (realPass.setBindGroup as (...args: unknown[]) => void)(index, bindGroup, ...rest);
      } else {
        const offsets = rest[0] as readonly number[] | undefined;
        dynOffsets = offsets === undefined ? undefined : Array.from(offsets);
        realPass.setBindGroup(index, bindGroup, offsets);
      }
      pushEvent(s, {
        kind: 'setBindGroup',
        passHandleId: passHId,
        index,
        bindGroupHandleId: bgid,
        dynamicOffsets: dynOffsets,
      });
    },
    draw(vertexCount, instanceCount, firstVertex, firstInstance) {
      pushEvent(s, {
        kind: 'draw',
        passHandleId: passHId,
        vertexCount,
        instanceCount: instanceCount ?? 1,
        firstVertex: firstVertex ?? 0,
        firstInstance: firstInstance ?? 0,
      });
      realPass.draw(vertexCount, instanceCount, firstVertex, firstInstance);
    },
    drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance) {
      pushEvent(s, {
        kind: 'drawIndexed',
        passHandleId: passHId,
        indexCount,
        instanceCount: instanceCount ?? 1,
        firstIndex: firstIndex ?? 0,
        baseVertex: baseVertex ?? 0,
        firstInstance: firstInstance ?? 0,
      });
      realPass.drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    },

    // Pass-through methods (not in v1 event set, but must not break the proxy)
    setViewport(x, y, w, h, minDepth, maxDepth) {
      pushEvent(s, {
        kind: 'setViewport',
        passHandleId: passHId,
        x,
        y,
        w,
        h,
        minDepth: minDepth ?? 0,
        maxDepth: maxDepth ?? 1,
      });
      realPass.setViewport(x, y, w, h, minDepth, maxDepth);
    },
    setScissorRect(x, y, w, h) {
      pushEvent(s, {
        kind: 'setScissorRect',
        passHandleId: passHId,
        x,
        y,
        w,
        h,
      });
      realPass.setScissorRect(x, y, w, h);
    },
    setBlendConstant(color) {
      pushEvent(s, {
        kind: 'setBlendConstant',
        passHandleId: passHId,
        color,
      });
      realPass.setBlendConstant(color);
    },
    setStencilReference(reference) {
      // Recorded (not a no-op pass-through): stencil pipelines compare against
      // this dynamic reference, so without it replay defaults ref=0 and a
      // not-equal/equal stencil test (e.g. the 4.2 stencil-testing outline
      // pass) silently breaks -- the outline vanishes on replay.
      pushEvent(s, {
        kind: 'setStencilReference',
        passHandleId: passHId,
        reference,
      });
      realPass.setStencilReference(reference);
    },
    drawIndirect(indirectBuffer, indirectOffset) {
      const ibId = getHandleId(s, indirectBuffer as object, 'buffer');
      pushEvent(s, {
        kind: 'drawIndirect',
        passHandleId: passHId,
        indirectBufferHandleId: ibId,
        indirectOffset,
      });
      realPass.drawIndirect(indirectBuffer, indirectOffset);
    },
    drawIndexedIndirect(indirectBuffer, indirectOffset) {
      const ibId = getHandleId(s, indirectBuffer as object, 'buffer');
      pushEvent(s, {
        kind: 'drawIndexedIndirect',
        passHandleId: passHId,
        indirectBufferHandleId: ibId,
        indirectOffset,
      });
      realPass.drawIndexedIndirect(indirectBuffer, indirectOffset);
    },
    pushDebugGroup(groupLabel) {
      pushEvent(s, {
        kind: 'passPushDebugGroup',
        passHandleId: passHId,
        groupLabel,
      });
      realPass.pushDebugGroup(groupLabel);
    },
    popDebugGroup() {
      pushEvent(s, { kind: 'passPopDebugGroup', passHandleId: passHId });
      realPass.popDebugGroup();
    },
    insertDebugMarker(markerLabel) {
      pushEvent(s, {
        kind: 'passInsertDebugMarker',
        passHandleId: passHId,
        markerLabel,
      });
      realPass.insertDebugMarker(markerLabel);
    },
    executeBundles(bundles) {
      return realPass.executeBundles(bundles);
    },
    beginOcclusionQuery(queryIndex) {
      return realPass.beginOcclusionQuery(queryIndex);
    },
    endOcclusionQuery() {
      return realPass.endOcclusionQuery();
    },
    end() {
      pushEvent(s, { kind: 'endRenderPass', passHandleId: passHId });
      realPass.end();
    },
  };
}

export function createComputePassProxy(
  s: RecorderInternal,
  realPass: RhiComputePassEncoder,
  passHId: HandleId,
): RhiComputePassEncoder {
  return {
    setPipeline(pipeline: ComputePipeline) {
      const pid = getHandleId(s, pipeline as object, 'computePipeline');
      pushEvent(s, { kind: 'setComputePipeline', passHandleId: passHId, pipelineHandleId: pid });
      realPass.setPipeline(pipeline);
    },
    setBindGroup(index, bindGroup, dynamicOffsets) {
      const bgid = getHandleId(s, bindGroup as object, 'bindGroup');
      const recordedDynamicOffsets =
        dynamicOffsets === undefined ? undefined : Array.from(dynamicOffsets);
      pushEvent(s, {
        kind: 'setBindGroup',
        passHandleId: passHId,
        index,
        bindGroupHandleId: bgid,
        dynamicOffsets: recordedDynamicOffsets,
      });
      realPass.setBindGroup(index, bindGroup, dynamicOffsets);
    },
    dispatchWorkgroups(x, y, z) {
      pushEvent(s, {
        kind: 'dispatchWorkgroups',
        passHandleId: passHId,
        x,
        y: y ?? 1,
        z: z ?? 1,
      });
      realPass.dispatchWorkgroups(x, y, z);
    },
    dispatchWorkgroupsIndirect(indirectBuffer, indirectOffset) {
      const bufferHandleId = getHandleId(s, indirectBuffer as object, 'buffer');
      pushEvent(s, {
        kind: 'dispatchWorkgroupsIndirect',
        passHandleId: passHId,
        indirectBufferHandleId: bufferHandleId,
        indirectOffset,
      });
      realPass.dispatchWorkgroupsIndirect(indirectBuffer, indirectOffset);
    },
    end() {
      pushEvent(s, { kind: 'endComputePass', passHandleId: passHId });
      realPass.end();
    },
  };
}

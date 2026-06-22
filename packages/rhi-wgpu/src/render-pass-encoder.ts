// packages/rhi-wgpu/src/render-pass-encoder.ts — RhiRenderPassEncoder (w18).
//
// Wraps a raw GPURenderPassEncoder / RhiWgpuRenderPassEncoder handle into the
// forgeax RhiRenderPassEncoder surface. M2 baseline routes each method
// through best-effort forwarding (no-op when raw handle missing the
// method); M3 / M4 dawn-node integration (w24) wires the real wgpu plumbing.
//
// Surface (mirrors @forgeax/engine-rhi/src/index.ts RhiRenderPassEncoder):
//   - setPipeline / setVertexBuffer / setIndexBuffer / setBindGroup
//     (2 overloads)
//   - draw / drawIndexed / drawIndirect / drawIndexedIndirect
//   - end / setViewport / setScissorRect / setBlendConstant / setStencilReference
//   - pushDebugGroup / popDebugGroup / insertDebugMarker (GPUDebugCommandsMixin)
//   - executeBundles / beginOcclusionQuery / endOcclusionQuery
//     (Result-wrapped placeholders, see feat-future-rhi-render-bundle)
//
// Anchors: plan-strategy §6 M2 + AC-08 surface gate.

/// <reference types="@webgpu/types" />

import {
  type BindGroup,
  type Buffer,
  ok,
  type RenderPipeline,
  type Result,
  type RhiError,
  type RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { unwrapBuffer } from './buffer';
import { webgpuRuntimeError } from './errors';

/**
 * Minimal shape of a raw render-pass-encoder handle the shim consumes.
 * Methods optional so the M2 baseline accepts both navigator.gpu and wgpu
 * wasm handles interchangeably.
 */
export interface RawRenderPassLike {
  setPipeline?(pipeline: unknown): void;
  // bug-20260610: u64 args accepted as number | bigint; the wasm-bindgen
  // class signature requires bigint, the navigator.gpu spec signature accepts
  // number. The shim coerces to BigInt at the call site.
  setVertexBuffer?(
    slot: number,
    buffer: unknown,
    offset?: number | bigint,
    size?: number | bigint,
  ): void;
  setIndexBuffer?(
    buffer: unknown,
    format: string,
    offset?: number | bigint,
    size?: number | bigint,
  ): void;
  setBindGroup?(...args: unknown[]): void;
  draw?(
    vertexCount: number,
    instanceCount?: number,
    firstVertex?: number,
    firstInstance?: number,
  ): void;
  drawIndexed?(
    indexCount: number,
    instanceCount?: number,
    firstIndex?: number,
    baseVertex?: number,
    firstInstance?: number,
  ): void;
  // bug-20260610: u64 indirectOffset coerces to BigInt for the wasm class
  // signature.
  drawIndirect?(indirectBuffer: unknown, indirectOffset: number | bigint): void;
  drawIndexedIndirect?(indirectBuffer: unknown, indirectOffset: number | bigint): void;
  end?(): void;
  setViewport?(
    x: number,
    y: number,
    w: number,
    h: number,
    minDepth: number,
    maxDepth: number,
  ): void;
  setScissorRect?(x: number, y: number, w: number, h: number): void;
  setBlendConstant?(color: unknown): void;
  setStencilReference?(reference: number): void;
  pushDebugGroup?(label: string): void;
  popDebugGroup?(): void;
  insertDebugMarker?(label: string): void;
  executeBundles?(bundles: Iterable<unknown>): void;
  beginOcclusionQuery?(queryIndex: number): void;
  endOcclusionQuery?(): void;
}

class RhiWgpuRenderPassEncoderImpl implements RhiRenderPassEncoder {
  private readonly raw: RawRenderPassLike;
  constructor(raw: RawRenderPassLike) {
    this.raw = raw;
  }

  setPipeline(pipeline: RenderPipeline): void {
    if (this.raw.setPipeline === undefined) return;
    this.raw.setPipeline.call(this.raw, pipeline);
  }

  setVertexBuffer(
    slot: number,
    buffer: Buffer,
    offset?: number | undefined,
    size?: number | undefined,
  ): void {
    if (this.raw.setVertexBuffer === undefined) return;
    // Resolve forgeax Buffer brand → raw GPUBuffer (M4 w25 integration; the
    // wrapped Buffer is rejected by dawn-node validation with
    // "object is not of the correct interface type").
    // bug-20260610: u64 args coerce to BigInt for the wasm class signature.
    // Safari WebGL2 fallback throws "Invalid argument type in ToBigInt"
    // without this. The 0 default mirrors the WebGPU spec.
    this.raw.setVertexBuffer.call(
      this.raw,
      slot,
      unwrapBuffer(buffer),
      offset !== undefined ? BigInt(offset) : BigInt(0),
      size !== undefined ? BigInt(size) : undefined,
    );
  }

  setIndexBuffer(
    buffer: Buffer,
    format: 'uint16' | 'uint32',
    offset?: number | undefined,
    size?: number | undefined,
  ): void {
    if (this.raw.setIndexBuffer === undefined) return;
    // bug-20260610: u64 → BigInt coerce (see setVertexBuffer above).
    this.raw.setIndexBuffer.call(
      this.raw,
      unwrapBuffer(buffer),
      format,
      offset !== undefined ? BigInt(offset) : BigInt(0),
      size !== undefined ? BigInt(size) : undefined,
    );
  }

  setBindGroup(
    index: number,
    bindGroup: BindGroup,
    dynamicOffsetsOrStart?: readonly number[] | Uint32Array | undefined,
    dynamicOffsetsLength?: number | undefined,
  ): void {
    if (this.raw.setBindGroup === undefined) return;
    if (dynamicOffsetsLength !== undefined) {
      this.raw.setBindGroup.call(
        this.raw,
        index,
        bindGroup,
        dynamicOffsetsOrStart,
        0,
        dynamicOffsetsLength,
      );
    } else if (dynamicOffsetsOrStart !== undefined) {
      this.raw.setBindGroup.call(this.raw, index, bindGroup, dynamicOffsetsOrStart);
    } else {
      this.raw.setBindGroup.call(this.raw, index, bindGroup);
    }
  }

  draw(
    vertexCount: number,
    instanceCount?: number | undefined,
    firstVertex?: number | undefined,
    firstInstance?: number | undefined,
  ): void {
    if (this.raw.draw === undefined) return;
    this.raw.draw.call(this.raw, vertexCount, instanceCount, firstVertex, firstInstance);
  }

  drawIndexed(
    indexCount: number,
    instanceCount?: number | undefined,
    firstIndex?: number | undefined,
    baseVertex?: number | undefined,
    firstInstance?: number | undefined,
  ): void {
    if (this.raw.drawIndexed === undefined) return;
    this.raw.drawIndexed.call(
      this.raw,
      indexCount,
      instanceCount,
      firstIndex,
      baseVertex,
      firstInstance,
    );
  }

  drawIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
    if (this.raw.drawIndirect === undefined) return;
    // bug-20260610: u64 → BigInt coerce.
    this.raw.drawIndirect.call(this.raw, unwrapBuffer(indirectBuffer), BigInt(indirectOffset));
  }

  drawIndexedIndirect(indirectBuffer: Buffer, indirectOffset: number): void {
    if (this.raw.drawIndexedIndirect === undefined) return;
    // bug-20260610: u64 → BigInt coerce.
    this.raw.drawIndexedIndirect.call(
      this.raw,
      unwrapBuffer(indirectBuffer),
      BigInt(indirectOffset),
    );
  }

  end(): void {
    if (this.raw.end === undefined) return;
    this.raw.end.call(this.raw);
  }

  setViewport(
    x: number,
    y: number,
    w: number,
    h: number,
    minDepth: number,
    maxDepth: number,
  ): void {
    if (this.raw.setViewport === undefined) return;
    this.raw.setViewport.call(this.raw, x, y, w, h, minDepth, maxDepth);
  }

  setScissorRect(x: number, y: number, w: number, h: number): void {
    if (this.raw.setScissorRect === undefined) return;
    this.raw.setScissorRect.call(this.raw, x, y, w, h);
  }

  setBlendConstant(color: GPUColor): void {
    if (this.raw.setBlendConstant === undefined) return;
    this.raw.setBlendConstant.call(this.raw, color);
  }

  setStencilReference(reference: number): void {
    if (this.raw.setStencilReference === undefined) return;
    this.raw.setStencilReference.call(this.raw, reference);
  }

  pushDebugGroup(groupLabel: string): void {
    if (this.raw.pushDebugGroup === undefined) return;
    this.raw.pushDebugGroup.call(this.raw, groupLabel);
  }

  popDebugGroup(): void {
    if (this.raw.popDebugGroup === undefined) return;
    this.raw.popDebugGroup.call(this.raw);
  }

  insertDebugMarker(markerLabel: string): void {
    if (this.raw.insertDebugMarker === undefined) return;
    this.raw.insertDebugMarker.call(this.raw, markerLabel);
  }

  executeBundles(bundles: Iterable<unknown>): Result<void, RhiError> {
    // feat-future-rhi-render-bundle anchor; M2 baseline returns
    // webgpuRuntimeError when the raw handle does not expose the method.
    if (this.raw.executeBundles === undefined) {
      return webgpuRuntimeError(new Error('executeBundles not implemented at M2 baseline'));
    }
    try {
      this.raw.executeBundles.call(this.raw, bundles);
      return ok(undefined);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  beginOcclusionQuery(queryIndex: number): Result<void, RhiError> {
    if (this.raw.beginOcclusionQuery === undefined) {
      return webgpuRuntimeError(new Error('beginOcclusionQuery not implemented at M2 baseline'));
    }
    try {
      this.raw.beginOcclusionQuery.call(this.raw, queryIndex);
      return ok(undefined);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }

  endOcclusionQuery(): Result<void, RhiError> {
    if (this.raw.endOcclusionQuery === undefined) {
      return webgpuRuntimeError(new Error('endOcclusionQuery not implemented at M2 baseline'));
    }
    try {
      this.raw.endOcclusionQuery.call(this.raw);
      return ok(undefined);
    } catch (e) {
      return webgpuRuntimeError(e);
    }
  }
}

export function makeRhiRenderPassEncoder(raw: RawRenderPassLike): RhiRenderPassEncoder {
  return new RhiWgpuRenderPassEncoderImpl(raw);
}

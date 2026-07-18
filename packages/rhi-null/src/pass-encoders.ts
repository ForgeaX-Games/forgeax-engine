// @forgeax/engine-rhi-null/src/pass-encoders - headless render / compute pass
// encoders.
//
// Both encoders are no-ops that thread state changes through nothing real; the
// only side effects are command-stream bookkeeping the M3 unit tests read back:
//   - draw / drawIndexed / drawIndirect / drawIndexedIndirect bump a draw
//     counter (AC-06);
//   - dispatchWorkgroups bumps a dispatch counter;
//   - setVertexBuffer / setBindGroup validate handle ownership against the
//     issuing device's ledger (AC-09 handle-chain consistency) and record the
//     outcome so an assertion can read the most recent validation result
//     without the call site throwing (the spec method form is void).
//
// Counters + last-validation live on the encoder instance (public readonly) so
// a test holding the pass encoder reads them directly; the per-device ledger
// (Bookkeeper) supplies cross-device validation.
//
// Related: requirements AC-04 (pass sequence) + AC-06 (draw count + binding
// assembly) + AC-09 (handle-chain consistency); research Finding A1 rows 6/7;
// plan-strategy §3.1 (pass encoder bookkeeping design) + §2 D-1.

import type {
  BindGroup,
  Buffer,
  ComputePipeline,
  RenderPipeline,
  Result,
  RhiComputePassEncoder,
  RhiError as RhiErrorType,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import type { Bookkeeper } from './bookkeeping';

/** Shared counter interface that pass encoders bump so the device can aggregate
 *  per-frame stats for M3 unit-test readback. */
export interface PassCounter {
  recordDraw(): void;
  recordBindGroup(): void;
  recordPassName(name: string): void;
}

/**
 * Headless render pass encoder. Records draw counts + the most recent handle
 * validation outcome; all state-setting methods are no-ops.
 */
export class RhiNullRenderPassEncoder implements RhiRenderPassEncoder {
  /** Number of draw* calls issued on this pass (AC-06 readback). */
  drawCount = 0;
  bindGroupCount = 0;
  /** Most recent setVertexBuffer / setBindGroup ownership validation; ok unless
   *  a foreign handle was passed (AC-09 readback). */
  lastValidation: Result<unknown, RhiErrorType> = ok(undefined);

  private readonly bookkeeper: Bookkeeper;
  private readonly counter: PassCounter | null;
  readonly passName: string;

  constructor(bookkeeper: Bookkeeper, counter: PassCounter | null, passName: string) {
    this.bookkeeper = bookkeeper;
    this.counter = counter;
    this.passName = passName;
  }

  setPipeline(_pipeline: RenderPipeline): void {}

  setVertexBuffer(
    _slot: number,
    buffer: Buffer,
    _offset?: number | undefined,
    _size?: number | undefined,
  ): void {
    this.lastValidation = this.bookkeeper.validateOwnership(buffer);
  }

  setIndexBuffer(
    _buffer: Buffer,
    _format: 'uint16' | 'uint32',
    _offset?: number | undefined,
    _size?: number | undefined,
  ): void {}

  setBindGroup(
    _index: number,
    bindGroup: BindGroup,
    _dynamicOffsetsData?: readonly number[] | Uint32Array | undefined,
    _dynamicOffsetsDataStart?: number | undefined,
    _dynamicOffsetsDataLength?: number | undefined,
  ): void {
    this.bindGroupCount++;
    this.counter?.recordBindGroup();
    this.lastValidation = this.bookkeeper.validateOwnership(bindGroup);
  }

  draw(
    _vertexCount: number,
    _instanceCount?: number | undefined,
    _firstVertex?: number | undefined,
    _firstInstance?: number | undefined,
  ): void {
    this.drawCount++;
    this.counter?.recordDraw();
  }

  drawIndexed(
    _indexCount: number,
    _instanceCount?: number | undefined,
    _firstIndex?: number | undefined,
    _baseVertex?: number | undefined,
    _firstInstance?: number | undefined,
  ): void {
    this.drawCount++;
    this.counter?.recordDraw();
  }

  end(): void {
    this.counter?.recordPassName(this.passName);
  }

  setViewport(
    _x: number,
    _y: number,
    _w: number,
    _h: number,
    _minDepth: number,
    _maxDepth: number,
  ): void {}

  setScissorRect(_x: number, _y: number, _w: number, _h: number): void {}

  setBlendConstant(_color: GPUColor): void {}

  setStencilReference(_reference: number): void {}

  drawIndirect(_indirectBuffer: Buffer, _indirectOffset: number): void {
    this.drawCount++;
  }

  drawIndexedIndirect(_indirectBuffer: Buffer, _indirectOffset: number): void {
    this.drawCount++;
  }

  pushDebugGroup(_groupLabel: string): void {}

  popDebugGroup(): void {}

  insertDebugMarker(_markerLabel: string): void {}

  executeBundles(_bundles: Iterable<unknown>): Result<void, RhiErrorType> {
    // Headless no-op: executing zero bundles against no GPU succeeds vacuously
    // (plan-strategy §3.1 — pass-encoder Result methods return ok(void)).
    return ok(undefined);
  }

  beginOcclusionQuery(_queryIndex: number): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  endOcclusionQuery(): Result<void, RhiErrorType> {
    return ok(undefined);
  }
}

/**
 * Headless compute pass encoder. Records dispatch counts; all state-setting
 * methods are no-ops.
 */
export class RhiNullComputePassEncoder implements RhiComputePassEncoder {
  /** Number of dispatchWorkgroups calls issued on this pass (readback). */
  dispatchCount = 0;
  /** Most recent setBindGroup ownership validation (AC-09 readback). */
  lastValidation: Result<unknown, RhiErrorType> = ok(undefined);

  private readonly bookkeeper: Bookkeeper;
  private readonly counter: PassCounter | null;
  readonly passName: string;

  constructor(bookkeeper: Bookkeeper, counter: PassCounter | null, passName: string) {
    this.bookkeeper = bookkeeper;
    this.counter = counter;
    this.passName = passName;
  }

  setPipeline(_pipeline: ComputePipeline): void {}

  setBindGroup(
    _index: number,
    bindGroup: BindGroup,
    _dynamicOffsets?: readonly number[] | undefined,
  ): void {
    this.lastValidation = this.bookkeeper.validateOwnership(bindGroup);
  }

  dispatchWorkgroups(_x: number, _y?: number | undefined, _z?: number | undefined): void {
    this.dispatchCount++;
  }

  end(): void {
    this.counter?.recordPassName(this.passName);
  }
}

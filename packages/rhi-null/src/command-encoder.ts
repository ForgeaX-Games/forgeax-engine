// @forgeax/engine-rhi-null/src/command-encoder - headless command encoder.
//
// RhiNullCommandEncoder is a no-op recorder: begin*Pass returns a fresh
// pass-encoder bound to the same per-device ledger; copy* / clear* / debug* /
// writeTimestamp are no-ops; resolveQuerySet / finish return ok. finish() mints
// a legal CommandBuffer brand through the ledger so submit-side bookkeeping
// (AC-12) can read it back.
//
// Each beginRenderPass / beginComputePass reads the `label` from the descriptor
// and threads it as the pass name to the per-device counters so M3 unit tests
// (w17 AC-04) can assert per-frame pass scheduling order.
//
// Related: requirements AC-04 (pass sequence) + AC-06 (draw count via pass
// encoders); research Finding A1 row 5; plan-strategy §3.1.

import type {
  Buffer,
  CommandBuffer,
  QuerySet,
  Result,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiError as RhiErrorType,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import type { Bookkeeper } from './bookkeeping';
import type { RhiNullDevice } from './device';
import {
  type PassCounter,
  RhiNullComputePassEncoder,
  RhiNullRenderPassEncoder,
} from './pass-encoders';

/**
 * Internal counter that writes per-frame stats back to the owning device.
 */
class DeviceCounter implements PassCounter {
  constructor(private readonly device: RhiNullDevice) {}

  recordDraw(): void {
    this.device.totalDrawCount++;
  }

  recordBindGroup(): void {
    this.device.totalBindGroupCount++;
  }

  recordPassName(name: string): void {
    this.device.framePassNames.push(name);
  }
}

/**
 * Read the `label` field from a GPURenderPassDescriptor (or undefined if not
 * set). The engine sets `label` on the render pass descriptor; the graph's
 * compile path doesn't always thread a per-pass label, so we fall back to the
 * RenderPassDescriptor's generic label (or '<unnamed>').
 */
function readPassLabel(desc: Record<string, unknown> | undefined): string {
  if (desc && typeof desc.label === 'string' && desc.label.length > 0) {
    return desc.label as string;
  }
  return '<unnamed>';
}

/**
 * Headless command encoder. begin*Pass returns a no-op pass encoder bound to
 * the issuing device's ledger; recording methods are no-ops; finish mints a
 * CommandBuffer brand.
 */
export class RhiNullCommandEncoder implements RhiCommandEncoder {
  private readonly bookkeeper: Bookkeeper;
  private readonly counter: PassCounter;

  constructor(bookkeeper: Bookkeeper, device: RhiNullDevice) {
    this.bookkeeper = bookkeeper;
    this.counter = new DeviceCounter(device);
  }

  beginRenderPass(desc: GPURenderPassDescriptor): RhiRenderPassEncoder {
    const label = readPassLabel(desc as unknown as Record<string, unknown>);
    return new RhiNullRenderPassEncoder(this.bookkeeper, this.counter, label);
  }

  beginComputePass(desc?: GPUComputePassDescriptor | undefined): RhiComputePassEncoder {
    const label = readPassLabel(desc as unknown as Record<string, unknown> | undefined);
    return new RhiNullComputePassEncoder(this.bookkeeper, this.counter, label);
  }

  copyBufferToBuffer(
    _source: Buffer,
    _sourceOffsetOrDestination: number | Buffer,
    _destinationOrSize?: Buffer | number | undefined,
    _destinationOffset?: number | undefined,
    _size?: number | undefined,
  ): void {}

  copyBufferToTexture(
    _source: GPUTexelCopyBufferInfo,
    _destination: GPUTexelCopyTextureInfo,
    _copySize: GPUExtent3DStrict,
  ): void {}

  copyTextureToBuffer(
    _source: GPUTexelCopyTextureInfo,
    _destination: GPUTexelCopyBufferInfo,
    _copySize: GPUExtent3DStrict,
  ): void {}

  copyTextureToTexture(
    _source: GPUTexelCopyTextureInfo,
    _destination: GPUTexelCopyTextureInfo,
    _copySize: GPUExtent3DStrict,
  ): void {}

  clearBuffer(_buffer: Buffer, _offset?: number | undefined, _size?: number | undefined): void {}

  resolveQuerySet(
    _querySet: QuerySet,
    _firstQuery: number,
    _queryCount: number,
    _destination: Buffer,
    _destinationOffset: number,
  ): Result<void, RhiErrorType> {
    return ok(undefined);
  }

  writeTimestamp(_querySet: QuerySet, _queryIndex: number): void {}

  pushDebugGroup(_groupLabel: string): void {}

  popDebugGroup(): void {}

  insertDebugMarker(_markerLabel: string): void {}

  finish(): Result<CommandBuffer, RhiErrorType> {
    return ok(this.bookkeeper.register('CommandBuffer') as unknown as CommandBuffer);
  }
}

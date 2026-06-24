// @forgeax/engine-rhi-null/src/device - RhiNullDevice + caps for the headless
// no-op backend.
//
// RhiNullDevice implements the full RhiDevice surface (research Finding A1
// row 3) as no-ops that mint legal opaque-handle brands and thread them through
// the per-device Bookkeeper (method A; research Finding A6). The `implements
// RhiDevice` clause is the completeness guard: a missing method is a tsc -b
// red, satisfying AC-01 without a hand-maintained member checklist.
//
// caps (D-5): backendKind 'null'; the 3 wgpu-native-only reserved flags
// (multiDrawIndirect / pushConstants / textureBindingArray) are false; every
// other boolean cap is true and maxColorAttachments is 8, so the headless
// backend maximizes structural coverage of capability-gated paths.
//
// The queue is supplied at construction (the adapter's requestDevice mints the
// RhiNullQueue, w10) so device.ts carries no dependency on queue.ts.
//
// Related: requirements scope row 2 (8 interfaces full method set) + AC-01
// (implements compiles) + AC-08 (backendKind === 'null'); plan-strategy §2 D-5
// (caps field-level) + §4 R-3; research Finding A1 + A6.

import type {
  BindGroup,
  BindGroupDescriptor,
  BindGroupLayout,
  BindGroupLayoutDescriptor,
  Buffer,
  BufferDescriptor,
  CommandEncoderDescriptor,
  ComputePipeline,
  ComputePipelineDescriptor,
  PipelineLayout,
  PipelineLayoutDescriptor,
  QuerySet,
  QuerySetDescriptor,
  RenderPipeline,
  RenderPipelineDescriptor,
  Result,
  RhiCaps,
  RhiCommandEncoder,
  RhiComputePipelineOps,
  RhiDevice,
  RhiError as RhiErrorType,
  RhiFeatures,
  RhiLimits,
  RhiQueue,
  RhiRenderPipelineOps,
  Sampler,
  SamplerDescriptor,
  Texture,
  TextureDescriptor,
  TextureView,
  TextureViewDescriptor,
} from '@forgeax/engine-rhi';
import { ok } from '@forgeax/engine-types';
import { Bookkeeper } from './bookkeeping';

/** Monotonic device-id source so each RhiNullDevice owns a distinct id; the id
 *  threads into the Bookkeeper for cross-device handle-chain validation. */
let nextDeviceId = 0;

/**
 * Factory that builds a command encoder bound to a device's ledger. Injected at
 * device construction (rather than imported here) so device.ts carries no
 * dependency on command-encoder.ts; the singleton assembly (index.ts) supplies
 * the real factory. The Bookkeeper and RhiNullDevice are passed so the encoder
 * threads draw / dispatch counts + binding validation through the same per-device
 * ledger AND writes aggregated frame stats to the device for M3 unit-test readback.
 */
export type CommandEncoderFactory = (
  bookkeeper: Bookkeeper,
  device: RhiNullDevice,
) => RhiCommandEncoder;

/** A pipeline brand augmented with its no-op `getBindGroupLayout` ops method
 *  (D-2). createRenderPipeline / createComputePipeline return objects of this
 *  shape so the auto-layout consumers can call getBindGroupLayout. */
type PipelineHandle<Brand> = Brand & RhiRenderPipelineOps & RhiComputePipelineOps;

/**
 * Headless no-op RhiDevice. Every create* mints a legal brand and records it;
 * every destroy* fail-fasts a double-destroy; caps reports the all-true-except-
 * reserved profile (D-5).
 */
export class RhiNullDevice implements RhiDevice {
  private readonly internalBookkeeper: Bookkeeper;
  private readonly nullQueue: RhiQueue;
  private readonly encoderFactory: CommandEncoderFactory;

  /** Per-frame total draw count across all pass encoders executed this frame
   *  (aggregated by the command encoder on finish, then reset). M3 unit tests
   *  (w17) read this to assert draw count >= 1 (AC-06). */
  totalDrawCount = 0;
  /** Per-frame total bind group set count (AC-06 / AC-05 readback). */
  totalBindGroupCount = 0;
  /** Per-frame pass names executed this frame, in schedule order (AC-04). */
  framePassNames: string[] = [];

  /** The per-device handle ledger — exposed so M3 tests can assert create/destroy
   *  pairing and BGL/PSO shape counts (AC-05/06/07). */
  get bookkeeper(): Bookkeeper {
    return this.internalBookkeeper;
  }

  constructor(queue: RhiQueue, encoderFactory: CommandEncoderFactory) {
    this.internalBookkeeper = new Bookkeeper(nextDeviceId++);
    this.nullQueue = queue;
    this.encoderFactory = encoderFactory;
  }

  get caps(): RhiCaps {
    return {
      backendKind: 'null',
      compute: true,
      timestampQuery: true,
      indirectDrawing: true,
      textureCompression: true,
      // 3 wgpu-native-only reserved flags stay false on non-native backends
      // (D-5); the headless backend is not a native runtime.
      multiDrawIndirect: false,
      pushConstants: false,
      textureBindingArray: false,
      samplerAliasing: true,
      firstInstanceIndirect: true,
      storageBuffer: true,
      storageTexture: true,
      rgba16floatRenderable: true,
      rg11b10ufloatRenderable: true,
      float32Filterable: true,
      maxColorAttachments: 8,
    };
  }

  get features(): RhiFeatures {
    return EMPTY_FEATURES;
  }

  get limits(): RhiLimits {
    return EMPTY_LIMITS;
  }

  get queue(): RhiQueue {
    return this.nullQueue;
  }

  // forgeax-async-whitelist: dom-native — spec `GPUDevice.lost` Promise
  // passthrough. The headless backend never loses a device (no GPU), so the
  // Promise stays unsettled for the lifetime of the device, mirroring a live
  // device that never transitions to the lost state.
  get lost(): Promise<{ readonly reason: 'destroyed' | 'unknown'; readonly message: string }> {
    return NEVER;
  }

  createBuffer(_desc: BufferDescriptor): Result<Buffer, RhiErrorType> {
    return ok(this.internalBookkeeper.register('Buffer') as unknown as Buffer);
  }

  createTexture(_desc: TextureDescriptor): Result<Texture, RhiErrorType> {
    return ok(this.internalBookkeeper.register('Texture') as unknown as Texture);
  }

  destroyBuffer(buf: Buffer): Result<void, RhiErrorType> {
    return this.internalBookkeeper.destroy(buf);
  }

  destroyTexture(tex: Texture): Result<void, RhiErrorType> {
    return this.internalBookkeeper.destroy(tex);
  }

  createTextureView(
    _texture: Texture,
    _desc: TextureViewDescriptor,
  ): Result<TextureView, RhiErrorType> {
    return ok(this.internalBookkeeper.register('TextureView') as unknown as TextureView);
  }

  createSampler(_desc?: SamplerDescriptor | undefined): Result<Sampler, RhiErrorType> {
    return ok(this.internalBookkeeper.register('Sampler') as unknown as Sampler);
  }

  createBindGroupLayout(_desc: BindGroupLayoutDescriptor): Result<BindGroupLayout, RhiErrorType> {
    return ok(this.internalBookkeeper.register('BindGroupLayout') as unknown as BindGroupLayout);
  }

  createBindGroup(_desc: BindGroupDescriptor): Result<BindGroup, RhiErrorType> {
    return ok(this.internalBookkeeper.register('BindGroup') as unknown as BindGroup);
  }

  createPipelineLayout(_desc: PipelineLayoutDescriptor): Result<PipelineLayout, RhiErrorType> {
    return ok(this.internalBookkeeper.register('PipelineLayout') as unknown as PipelineLayout);
  }

  createRenderPipeline(_desc: RenderPipelineDescriptor): Result<RenderPipeline, RhiErrorType> {
    return ok(this.makePipeline<RenderPipeline>('RenderPipeline'));
  }

  createComputePipeline(_desc: ComputePipelineDescriptor): Result<ComputePipeline, RhiErrorType> {
    return ok(this.makePipeline<ComputePipeline>('ComputePipeline'));
  }

  createQuerySet(_desc: QuerySetDescriptor): Result<QuerySet, RhiErrorType> {
    return ok(this.internalBookkeeper.register('QuerySet') as unknown as QuerySet);
  }

  createCommandEncoder(
    _desc?: CommandEncoderDescriptor | undefined,
  ): Result<RhiCommandEncoder, RhiErrorType> {
    return ok(this.encoderFactory(this.internalBookkeeper, this));
  }

  /**
   * Mint a pipeline handle whose object also carries the no-op
   * `getBindGroupLayout(index)` ops method (D-2). The prod auto-layout path
   * (debug-draw.ts) and the existing mock unit tests both call
   * `pipeline.getBindGroupLayout(n)`; returning a legal BindGroupLayout brand
   * (recorded in the ledger) keeps those consumers from crashing on a missing
   * method.
   */
  private makePipeline<Brand>(kind: string): PipelineHandle<Brand> {
    const handle = this.internalBookkeeper.register(kind);
    const getBindGroupLayout = (_index: number): BindGroupLayout =>
      this.internalBookkeeper.register('BindGroupLayout') as unknown as BindGroupLayout;
    return Object.assign(handle, { getBindGroupLayout }) as unknown as PipelineHandle<Brand>;
  }
}

/** Empty enabled-feature set — headless backend enables nothing beyond the
 *  always-true caps profile (research Finding A1: features getter returns an
 *  empty ReadonlySet). */
const EMPTY_FEATURES: RhiFeatures = new Set() as RhiFeatures;

/** Empty numeric-limits map. The headless backend reports no concrete numeric
 *  limits; capability planning reads caps booleans instead. */
const EMPTY_LIMITS: RhiLimits = {} as RhiLimits;

/** A Promise that never settles, mirroring a live GPUDevice.lost that stays
 *  unsettled while the device is healthy. */
const NEVER: Promise<{ readonly reason: 'destroyed' | 'unknown'; readonly message: string }> =
  new Promise(() => {});

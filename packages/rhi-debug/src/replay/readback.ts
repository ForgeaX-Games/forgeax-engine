import type {
  Buffer,
  MappedBuffer,
  RhiCommandEncoder,
  RhiDevice,
  Texture,
} from '@forgeax/engine-rhi';
import { err, ok, type Result } from '@forgeax/engine-types';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import type { CreateShaderModuleFn } from '../recorder';
import type { ResourceTable, ResourceTableEntry } from './resources';
import {
  getTextureReadbackPlan,
  isDepthStencilTextureFormat,
  isDepthTextureFormat,
  textureBytesPerTexel,
} from './texture-format';

const COPY_DST_MAP_READ = 0x9;
const GPU_MAP_MODE_READ = 0x1;

export interface BufferReadbackRange {
  readonly offset: number;
  readonly size?: number;
}

export interface TextureReadbackSubresource {
  readonly mipLevel?: number;
  readonly arrayLayer?: number;
  readonly aspect?: 'all' | 'depth-only' | 'stencil-only';
}

export type ReplayReadbackRequest = BufferReadbackRange | TextureReadbackSubresource;

export interface ReplayReadbackProvenance {
  readonly generation: number;
  readonly resourceId: string;
  readonly subresource: ReplayReadbackRequest | null;
  readonly selectedWorkIndex?: number;
}

export interface ReplayReadbackResult {
  readonly resourceId: string;
  readonly kind: 'buffer' | 'texture';
  readonly format?: string;
  readonly width?: number;
  readonly height?: number;
  readonly bytes: Uint8Array;
  readonly provenance: ReplayReadbackProvenance;
}

type ReplayReadbackPayload = Omit<ReplayReadbackResult, 'provenance'>;

export async function readReplayResource(
  device: RhiDevice,
  table: ResourceTable,
  resourceId: string,
  subresource: ReplayReadbackRequest | undefined,
  createShaderModule: CreateShaderModuleFn,
): Promise<Result<ReplayReadbackResult, RhiDebugError>> {
  const entry = table.get(resourceId);
  if (entry === undefined)
    return readbackFailure(`resource ${resourceId} is not present in the current generation`);
  let result: Result<ReplayReadbackPayload, RhiDebugError>;
  if (entry.resource.kind === 'texture-view') {
    const sourceId = stringField(entry.descriptor, 'sourceHandleId');
    const source = sourceId === undefined ? undefined : table.get(sourceId);
    if (source === undefined || source.resource.kind !== 'texture') {
      return readbackFailure(`texture view ${resourceId} has no readable source texture`);
    }
    const sourceSubresource = resolveTextureViewSubresource(entry, source, subresource);
    if (!sourceSubresource.ok) return sourceSubresource;
    result = await readTexture(
      device,
      source,
      resourceId,
      sourceSubresource.value,
      createShaderModule,
    );
  } else if (entry.resource.kind === 'texture') {
    result = await readTexture(device, entry, resourceId, subresource, createShaderModule);
  } else if (entry.resource.kind === 'buffer') {
    result = await readBuffer(device, entry, resourceId, subresource);
  } else {
    return readbackFailure(`resource ${resourceId} is not readable by the v7 core matrix`);
  }
  if (!result.ok) return result;
  return ok({
    ...result.value,
    provenance: {
      generation: table.generation,
      resourceId,
      subresource: subresource ?? null,
    },
  });
}

function resolveTextureViewSubresource(
  view: ResourceTableEntry,
  source: ResourceTableEntry,
  requested: ReplayReadbackRequest | undefined,
): Result<ReplayReadbackRequest | undefined, RhiDebugError> {
  if (requested === undefined || isBufferRange(requested)) return ok(requested);
  const sourceDescriptor = recordField(source.descriptor, 'desc');
  const sourceSize = textureSize(sourceDescriptor?.size);
  const sourceMipCount = numberField(sourceDescriptor, 'mipLevelCount') ?? 1;
  const viewDescriptor = recordField(view.descriptor, 'desc');
  const baseMipLevel = numberField(viewDescriptor, 'baseMipLevel') ?? 0;
  const baseArrayLayer = numberField(viewDescriptor, 'baseArrayLayer') ?? 0;
  const mipLevelCount =
    numberField(viewDescriptor, 'mipLevelCount') ?? sourceMipCount - baseMipLevel;
  const arrayLayerCount =
    numberField(viewDescriptor, 'arrayLayerCount') ??
    sourceSize.depthOrArrayLayers - baseArrayLayer;
  const localMipLevel = requested.mipLevel ?? 0;
  const localArrayLayer = requested.arrayLayer ?? 0;
  if (
    !validIndex(baseMipLevel, sourceMipCount + 1) ||
    !validIndex(baseArrayLayer, sourceSize.depthOrArrayLayers + 1) ||
    !validIndex(localMipLevel, mipLevelCount) ||
    !validIndex(localArrayLayer, arrayLayerCount) ||
    baseMipLevel + mipLevelCount > sourceMipCount ||
    baseArrayLayer + arrayLayerCount > sourceSize.depthOrArrayLayers
  ) {
    return readbackFailure('texture view subresource is outside the recorded view extent');
  }
  return ok({
    ...requested,
    mipLevel: baseMipLevel + localMipLevel,
    arrayLayer: baseArrayLayer + localArrayLayer,
  });
}

async function readBuffer(
  device: RhiDevice,
  entry: ResourceTableEntry,
  resourceId: string,
  subresource: ReplayReadbackRequest | undefined,
): Promise<Result<ReplayReadbackPayload, RhiDebugError>> {
  const size = numberField(recordField(entry.descriptor, 'desc'), 'size');
  if (size === undefined || !Number.isSafeInteger(size) || size < 0)
    return readbackFailure(`buffer ${resourceId} has no valid recorded size`);
  const request = isBufferRange(subresource) ? subresource : undefined;
  const offset = request?.offset ?? 0;
  const requestedSize = request?.size ?? size - offset;
  if (!validRange(offset, requestedSize, size))
    return readbackFailure(
      `buffer range ${offset}:${requestedSize} escapes ${resourceId} (${size} bytes)`,
    );
  const bytes = await copyBufferBytes(
    device,
    entry.resource.value as Buffer,
    offset,
    requestedSize,
  );
  if (!bytes.ok) return bytes;
  return ok({ resourceId, kind: 'buffer', bytes: bytes.value });
}

async function readTexture(
  device: RhiDevice,
  entry: ResourceTableEntry,
  resourceId: string,
  subresource: ReplayReadbackRequest | undefined,
  createShaderModule: CreateShaderModuleFn,
): Promise<Result<ReplayReadbackPayload, RhiDebugError>> {
  const descriptor = recordField(entry.descriptor, 'desc');
  const format = stringField(descriptor, 'format');
  const dimension = stringField(descriptor, 'dimension') ?? '2d';
  if (format === undefined) return readbackFailure(`texture ${resourceId} has no recorded format`);
  const plan = getTextureReadbackPlan({ format, dimension });
  if (!plan.supported) {
    return err(
      createRhiDebugError('readback-unsupported', {
        stage: 'readback',
        resourceId,
        format,
        reason: plan.reason,
      }),
    );
  }
  const size = textureSize(recordField(descriptor, 'size'));
  const mipLevel = textureSubresourceField(subresource, 'mipLevel') ?? 0;
  const arrayLayer = textureSubresourceField(subresource, 'arrayLayer') ?? 0;
  const mipCount = numberField(descriptor, 'mipLevelCount') ?? 1;
  if (
    !validIndex(mipLevel, mipCount) ||
    !Number.isInteger(arrayLayer) ||
    arrayLayer < 0 ||
    arrayLayer >= size.depthOrArrayLayers
  ) {
    return readbackFailure(`texture subresource for ${resourceId} is outside the recorded extent`);
  }
  const width = Math.max(1, Math.floor(size.width / 2 ** mipLevel));
  const height = Math.max(1, Math.floor(size.height / 2 ** mipLevel));
  const requestedAspect = textureAspect(subresource);
  if (isDepthStencilTextureFormat(format)) {
    if (requestedAspect === 'all') {
      return readbackUnsupported(
        resourceId,
        format,
        `${format} requires an explicit depth-only or stencil-only aspect`,
      );
    }
    if (requestedAspect === 'stencil-only') {
      const bytes = await copyTextureBytes(
        device,
        entry.resource.value as Texture,
        align256(width) * height,
        {
          mipLevel,
          arrayLayer,
          aspect: 'stencil-only',
          width,
          height,
          bytesPerRow: align256(width),
          rowBytes: width,
        },
      );
      if (!bytes.ok) return bytes;
      return ok({ resourceId, kind: 'texture', format, width, height, bytes: bytes.value });
    }
    if (format === 'depth24plus-stencil8') {
      return blitDepth24PlusTexture(
        device,
        entry.resource.value as Texture,
        resourceId,
        format,
        width,
        height,
        mipLevel,
        arrayLayer,
        createShaderModule,
      );
    }
  }
  if (format === 'depth24plus') {
    if (requestedAspect === 'stencil-only') {
      return readbackUnsupported(resourceId, format, 'depth24plus has no stencil aspect');
    }
    return blitDepth24PlusTexture(
      device,
      entry.resource.value as Texture,
      resourceId,
      format,
      width,
      height,
      mipLevel,
      arrayLayer,
      createShaderModule,
    );
  }
  const texelBytes = textureBytesPerTexel(format);
  if (texelBytes === undefined)
    return readbackFailure(`texture format ${format} has no byte layout`);
  const rowBytes = width * texelBytes;
  const bytesPerRow = align256(rowBytes);
  const bytes = await copyTextureBytes(
    device,
    entry.resource.value as Texture,
    bytesPerRow * height,
    {
      mipLevel,
      arrayLayer,
      aspect: directTextureAspect(format, requestedAspect),
      width,
      height,
      bytesPerRow,
      rowBytes,
    },
  );
  if (!bytes.ok) return bytes;
  return ok({ resourceId, kind: 'texture', format, width, height, bytes: bytes.value });
}

function readbackUnsupported(
  resourceId: string,
  format: string,
  reason: string,
): Result<never, RhiDebugError> {
  return err(
    createRhiDebugError('readback-unsupported', {
      stage: 'readback',
      resourceId,
      format,
      reason,
    }),
  );
}

function directTextureAspect(
  format: string,
  aspect: 'all' | 'depth-only' | 'stencil-only',
): 'all' | 'depth-only' | 'stencil-only' {
  if (isDepthTextureFormat(format) && !isDepthStencilTextureFormat(format)) {
    return 'depth-only';
  }
  if (isDepthStencilTextureFormat(format) && aspect === 'all') return 'depth-only';
  return aspect;
}

const DEPTH_BLIT_SHADER = `
@group(0) @binding(0) var sourceDepth: texture_depth_2d;

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  var output: VertexOutput;
  output.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return output;
}

@fragment
fn fs_main(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
  let pixel = vec2<i32>(i32(position.x), i32(position.y));
  return vec4<f32>(textureLoad(sourceDepth, pixel, 0), 0.0, 0.0, 1.0);
}
`;

async function blitDepth24PlusTexture(
  device: RhiDevice,
  source: Texture,
  resourceId: string,
  format: string,
  width: number,
  height: number,
  mipLevel: number,
  arrayLayer: number,
  createShaderModule: CreateShaderModuleFn,
): Promise<Result<ReplayReadbackPayload, RhiDebugError>> {
  let output: Texture | undefined;
  let staging: Buffer | undefined;
  let mapped: MappedBuffer | undefined;
  try {
    const sourceView = device.createTextureView(source, {
      dimension: '2d',
      baseMipLevel: mipLevel,
      mipLevelCount: 1,
      baseArrayLayer: arrayLayer,
      arrayLayerCount: 1,
      aspect: 'depth-only',
    });
    if (!sourceView.ok)
      return readbackFailure(
        `depth readback source view creation failed: ${sourceView.error.code}`,
      );

    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: 0x2,
          texture: { sampleType: 'depth', viewDimension: '2d', multisampled: false },
        },
      ],
    });
    if (!layout.ok)
      return readbackFailure(`depth readback bind group layout failed: ${layout.error.code}`);
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
    if (!pipelineLayout.ok)
      return readbackFailure(`depth readback pipeline layout failed: ${pipelineLayout.error.code}`);
    const shader = await createShaderModule(device, {
      code: DEPTH_BLIT_SHADER,
      label: 'rhi-debug-depth-readback',
    });
    if (!shader.ok) return readbackFailure(`depth readback shader failed: ${shader.error.code}`);
    const pipeline = device.createRenderPipeline({
      layout: pipelineLayout.value,
      vertex: { module: shader.value, entryPoint: 'vs_main', buffers: [] },
      fragment: {
        module: shader.value,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba32float' }],
      },
      primitive: { topology: 'triangle-list' },
    } as never);
    if (!pipeline.ok)
      return readbackFailure(`depth readback pipeline failed: ${pipeline.error.code}`);
    const bindGroup = device.createBindGroup({
      layout: layout.value,
      entries: [{ binding: 0, resource: { kind: 'textureView', value: sourceView.value } }],
    });
    if (!bindGroup.ok)
      return readbackFailure(`depth readback bind group failed: ${bindGroup.error.code}`);

    const outputResult = device.createTexture({
      size: { width, height, depthOrArrayLayers: 1 },
      format: 'rgba32float',
      dimension: '2d',
      mipLevelCount: 1,
      sampleCount: 1,
      usage: 0x11,
    });
    if (!outputResult.ok)
      return readbackFailure(`depth readback output texture failed: ${outputResult.error.code}`);
    output = outputResult.value;
    const outputView = device.createTextureView(output, { dimension: '2d' });
    if (!outputView.ok)
      return readbackFailure(`depth readback output view failed: ${outputView.error.code}`);

    const encoderResult = device.createCommandEncoder({});
    if (!encoderResult.ok)
      return readbackFailure(`depth readback encoder failed: ${encoderResult.error.code}`);
    const pass = encoderResult.value.beginRenderPass({
      colorAttachments: [
        {
          view: outputView.value,
          loadOp: 'clear',
          storeOp: 'store',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
        },
      ],
    } as never);
    pass.setPipeline(pipeline.value);
    pass.setBindGroup(0, bindGroup.value);
    pass.draw(3, 1, 0, 0);
    pass.end();

    const bytesPerRow = align256(width * 16);
    const created = device.createBuffer({ size: bytesPerRow * height, usage: COPY_DST_MAP_READ });
    if (!created.ok)
      return readbackFailure(`depth readback staging buffer failed: ${created.error.code}`);
    staging = created.value;
    encoderResult.value.copyTextureToBuffer(
      { texture: output, aspect: 'all' } as never,
      { buffer: staging, offset: 0, bytesPerRow, rowsPerImage: height } as never,
      { width, height, depthOrArrayLayers: 1 },
    );
    const finished = encoderResult.value.finish();
    if (!finished.ok)
      return readbackFailure(`depth readback finish failed: ${finished.error.code}`);
    const submitted = device.queue.submit([finished.value]);
    if (!submitted.ok)
      return readbackFailure(`depth readback submit failed: ${submitted.error.code}`);
    await device.queue.onSubmittedWorkDone();
    const mappedResult = await staging.mapAsync(GPU_MAP_MODE_READ);
    if (!mappedResult.ok)
      return readbackFailure(`depth readback map failed: ${mappedResult.error.code}`);
    mapped = mappedResult.value;
    const range = mapped.getMappedRange(0, bytesPerRow * height);
    if (!range.ok)
      return readbackFailure(`depth readback mapped range failed: ${range.error.code}`);
    const padded = new Uint8Array(range.value);
    const bytes = new Uint8Array(width * height * 4);
    for (let row = 0; row < height; row++) {
      for (let column = 0; column < width; column++) {
        const sourceOffset = row * bytesPerRow + column * 16;
        const targetOffset = (row * width + column) * 4;
        bytes.set(padded.subarray(sourceOffset, sourceOffset + 4), targetOffset);
      }
    }
    return ok({ resourceId, kind: 'texture', format, width, height, bytes });
  } catch (cause) {
    return readbackFailure(`depth readback failed: ${messageOf(cause)}`);
  } finally {
    if (mapped !== undefined) mapped.unmap();
    if (staging !== undefined) device.destroyBuffer(staging);
    if (output !== undefined) device.destroyTexture(output);
  }
}

async function copyBufferBytes(
  device: RhiDevice,
  source: Buffer,
  sourceOffset: number,
  size: number,
): Promise<Result<Uint8Array, RhiDebugError>> {
  let staging: Buffer | undefined;
  let mapped: MappedBuffer | undefined;
  try {
    const alignedSourceOffset = sourceOffset - (sourceOffset % 4);
    const leadingBytes = sourceOffset - alignedSourceOffset;
    const copySize = align4(leadingBytes + size);
    const created = device.createBuffer({ size: Math.max(4, copySize), usage: COPY_DST_MAP_READ });
    if (!created.ok)
      return readbackFailure(`staging buffer creation failed: ${created.error.code}`);
    staging = created.value;
    const encoderResult = device.createCommandEncoder({});
    if (!encoderResult.ok)
      return readbackFailure(`readback encoder creation failed: ${encoderResult.error.code}`);
    const encoder = encoderResult.value;
    encoder.copyBufferToBuffer(source, alignedSourceOffset, staging, 0, copySize);
    const finished = encoder.finish();
    if (!finished.ok)
      return readbackFailure(`readback encoder finish failed: ${finished.error.code}`);
    const submitted = device.queue.submit([finished.value]);
    if (!submitted.ok) return readbackFailure(`readback submit failed: ${submitted.error.code}`);
    await device.queue.onSubmittedWorkDone();
    const mappedResult = await staging.mapAsync(GPU_MAP_MODE_READ);
    if (!mappedResult.ok) return readbackFailure(`readback map failed: ${mappedResult.error.code}`);
    mapped = mappedResult.value;
    const range = mapped.getMappedRange(0, copySize);
    if (!range.ok) return readbackFailure(`readback mapped range failed: ${range.error.code}`);
    return ok(new Uint8Array(range.value).slice(leadingBytes, leadingBytes + size));
  } catch (cause) {
    return readbackFailure(`buffer readback failed: ${messageOf(cause)}`);
  } finally {
    if (mapped !== undefined) mapped.unmap();
    if (staging !== undefined) device.destroyBuffer(staging);
  }
}

async function copyTextureBytes(
  device: RhiDevice,
  source: Texture,
  bufferSize: number,
  copy: {
    readonly mipLevel: number;
    readonly arrayLayer: number;
    readonly aspect: 'all' | 'depth-only' | 'stencil-only';
    readonly width: number;
    readonly height: number;
    readonly bytesPerRow: number;
    readonly rowBytes: number;
  },
): Promise<Result<Uint8Array, RhiDebugError>> {
  let staging: Buffer | undefined;
  let mapped: MappedBuffer | undefined;
  try {
    const created = device.createBuffer({ size: bufferSize, usage: COPY_DST_MAP_READ });
    if (!created.ok)
      return readbackFailure(`staging buffer creation failed: ${created.error.code}`);
    staging = created.value;
    const encoderResult = device.createCommandEncoder({});
    if (!encoderResult.ok)
      return readbackFailure(`readback encoder creation failed: ${encoderResult.error.code}`);
    const encoder: RhiCommandEncoder = encoderResult.value;
    encoder.copyTextureToBuffer(
      {
        texture: source,
        mipLevel: copy.mipLevel,
        origin: { x: 0, y: 0, z: copy.arrayLayer },
        aspect: copy.aspect,
      } as never,
      {
        buffer: staging,
        offset: 0,
        bytesPerRow: copy.bytesPerRow,
        rowsPerImage: copy.height,
      } as never,
      { width: copy.width, height: copy.height, depthOrArrayLayers: 1 },
    );
    const finished = encoder.finish();
    if (!finished.ok)
      return readbackFailure(`readback encoder finish failed: ${finished.error.code}`);
    const submitted = device.queue.submit([finished.value]);
    if (!submitted.ok) return readbackFailure(`readback submit failed: ${submitted.error.code}`);
    await device.queue.onSubmittedWorkDone();
    const mappedResult = await staging.mapAsync(GPU_MAP_MODE_READ);
    if (!mappedResult.ok) return readbackFailure(`readback map failed: ${mappedResult.error.code}`);
    mapped = mappedResult.value;
    const range = mapped.getMappedRange(0, bufferSize);
    if (!range.ok) return readbackFailure(`readback mapped range failed: ${range.error.code}`);
    const padded = new Uint8Array(range.value);
    const bytes = new Uint8Array(copy.rowBytes * copy.height);
    for (let row = 0; row < copy.height; row++) {
      bytes.set(
        padded.subarray(row * copy.bytesPerRow, row * copy.bytesPerRow + copy.rowBytes),
        row * copy.rowBytes,
      );
    }
    return ok(bytes);
  } catch (cause) {
    return readbackFailure(`texture readback failed: ${messageOf(cause)}`);
  } finally {
    if (mapped !== undefined) mapped.unmap();
    if (staging !== undefined) device.destroyBuffer(staging);
  }
}

function readbackFailure(cause: string): Result<never, RhiDebugError> {
  return err(createRhiDebugError('readback-failed', { stage: 'readback', cause }));
}

function recordField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const field = value?.[key];
  return field !== null && typeof field === 'object'
    ? (field as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' ? field : undefined;
}

function numberField(value: Record<string, unknown> | undefined, key: string): number | undefined {
  const field = value?.[key];
  return typeof field === 'number' ? field : undefined;
}

function textureSize(value: unknown): {
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
} {
  if (Array.isArray(value)) {
    return {
      width: integerOr(value[0], 1),
      height: integerOr(value[1], integerOr(value[0], 1)),
      depthOrArrayLayers: integerOr(value[2], 1),
    };
  }
  const object =
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  return {
    width: integerOr(object?.width, 1),
    height: integerOr(object?.height, integerOr(object?.width, 1)),
    depthOrArrayLayers: integerOr(object?.depthOrArrayLayers, 1),
  };
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function textureSubresourceField(
  value: ReplayReadbackRequest | undefined,
  key: 'mipLevel' | 'arrayLayer',
): number | undefined {
  if (value === undefined || isBufferRange(value)) return undefined;
  return value[key];
}

function textureAspect(
  value: ReplayReadbackRequest | undefined,
): 'all' | 'depth-only' | 'stencil-only' {
  if (value === undefined || isBufferRange(value)) return 'all';
  return value.aspect ?? 'all';
}

function isBufferRange(value: ReplayReadbackRequest | undefined): value is BufferReadbackRange {
  return value !== undefined && 'offset' in value;
}

function validRange(offset: number, size: number, total: number): boolean {
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(size) &&
    offset >= 0 &&
    size >= 0 &&
    offset + size <= total
  );
}

function validIndex(value: number, count: number): boolean {
  return Number.isInteger(value) && value >= 0 && value < count;
}

function align256(value: number): number {
  return Math.max(256, Math.ceil(value / 256) * 256);
}

function align4(value: number): number {
  return Math.ceil(value / 4) * 4;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

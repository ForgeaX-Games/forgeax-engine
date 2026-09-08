import type { Buffer, Texture, TextureView } from '@forgeax/engine-rhi';
import type {
  GraphAccess,
  GraphBuffer,
  GraphBufferDescriptor,
  GraphPass,
  GraphResourceKind,
  GraphResourceOrigin,
  GraphTexture,
  GraphTextureDescriptor,
  GraphTextureView,
  GraphTextureViewDescriptor,
  ImportedBufferDescriptor,
  ImportedTextureDescriptor,
  ImportedTextureViewResolver,
  RenderGraphFrame,
} from './types.js';

export interface TextureHandleData {
  readonly owner: object;
  readonly id: number;
  readonly kind: 'texture';
}

export interface TextureViewHandleData {
  readonly owner: object;
  readonly id: number;
  readonly kind: 'texture-view';
  readonly textureId: number;
}

export interface BufferHandleData {
  readonly owner: object;
  readonly id: number;
  readonly kind: 'buffer';
}

export type ResourceHandleData = TextureHandleData | TextureViewHandleData | BufferHandleData;

export function textureHandle(owner: object, id: number): GraphTexture {
  return Object.freeze({ owner, id, kind: 'texture' }) as unknown as GraphTexture;
}

export function textureViewHandle(owner: object, id: number, textureId: number): GraphTextureView {
  return Object.freeze({
    owner,
    id,
    kind: 'texture-view',
    textureId,
  }) as unknown as GraphTextureView;
}

export function bufferHandle(owner: object, id: number): GraphBuffer {
  return Object.freeze({ owner, id, kind: 'buffer' }) as unknown as GraphBuffer;
}

export function handleData(resource: unknown): ResourceHandleData | undefined {
  if (typeof resource !== 'object' || resource === null) return undefined;
  const candidate = resource as Partial<ResourceHandleData>;
  if (typeof candidate.id !== 'number' || typeof candidate.owner !== 'object') return undefined;
  if (
    candidate.kind !== 'texture' &&
    candidate.kind !== 'texture-view' &&
    candidate.kind !== 'buffer'
  ) {
    return undefined;
  }
  return candidate as ResourceHandleData;
}

interface ResourceRecordBase {
  readonly id: number;
  readonly label: string;
  readonly kind: GraphResourceKind;
  readonly origin: GraphResourceOrigin;
}

export interface CreatedTextureRecord extends ResourceRecordBase {
  readonly kind: 'texture';
  readonly origin: 'created';
  readonly descriptor: GraphTextureDescriptor;
}

export interface ImportedTextureRecord<FrameCtx> extends ResourceRecordBase {
  readonly kind: 'texture';
  readonly origin: 'imported';
  readonly descriptor: ImportedTextureDescriptor;
  readonly resolve: (frame: FrameCtx) => Texture;
}

export interface CreatedBufferRecord extends ResourceRecordBase {
  readonly kind: 'buffer';
  readonly origin: 'created';
  readonly descriptor: GraphBufferDescriptor;
}

export interface ImportedBufferRecord<FrameCtx> extends ResourceRecordBase {
  readonly kind: 'buffer';
  readonly origin: 'imported';
  readonly descriptor: ImportedBufferDescriptor;
  readonly resolve: (frame: FrameCtx) => Buffer;
}

export type ResourceRecord<FrameCtx> =
  | CreatedTextureRecord
  | ImportedTextureRecord<FrameCtx>
  | CreatedBufferRecord
  | ImportedBufferRecord<FrameCtx>;

export interface TextureViewRecord<FrameCtx extends RenderGraphFrame = RenderGraphFrame> {
  readonly id: number;
  readonly label: string;
  readonly textureId: number;
  readonly descriptor: GraphTextureViewDescriptor;
  readonly resolve?: ImportedTextureViewResolver<FrameCtx> | undefined;
}

export interface PassRecord<FrameCtx extends RenderGraphFrame> {
  readonly id: number;
  readonly name: string;
  readonly pass: GraphPass<FrameCtx>;
}

export interface CompiledResource<FrameCtx> {
  readonly record: ResourceRecord<FrameCtx>;
  readonly usage: number;
  readonly firstUse: number | null;
  readonly lastUse: number | null;
  readonly texture?: Texture | undefined;
  readonly buffer?: Buffer | undefined;
}

export interface CompiledView<FrameCtx extends RenderGraphFrame = RenderGraphFrame> {
  readonly record: TextureViewRecord<FrameCtx>;
  readonly view?: TextureView | undefined;
}

export interface CompiledPass<FrameCtx extends RenderGraphFrame> extends PassRecord<FrameCtx> {
  readonly dependencies: readonly number[];
  readonly resourceIds: ReadonlySet<number>;
  readonly viewIds: ReadonlySet<number>;
}

export function accessResourceId(access: GraphAccess): number | undefined {
  const data = handleData(access.resource);
  if (data?.kind === 'texture-view') return data.textureId;
  return data?.id;
}

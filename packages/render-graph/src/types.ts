import type {
  Buffer,
  ComputePassDescriptor,
  RhiCommandEncoder,
  RhiComputePassEncoder,
  RhiDevice,
  RhiRenderPassEncoder,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import type { RenderGraphError, Result } from './errors.js';

declare const graphTextureBrand: unique symbol;
declare const graphTextureViewBrand: unique symbol;
declare const graphBufferBrand: unique symbol;

export interface GraphTexture {
  readonly [graphTextureBrand]: true;
}

export interface GraphTextureView {
  readonly [graphTextureViewBrand]: true;
}

export interface GraphBuffer {
  readonly [graphBufferBrand]: true;
}

export type GraphResource = GraphTexture | GraphTextureView | GraphBuffer;
export type GraphResourceOrigin = 'created' | 'imported';
export type GraphResourceKind = 'texture' | 'buffer';
export type GraphPassKind = 'raster' | 'compute' | 'copy';

export type GraphExtent =
  | 'surface'
  | 'half-surface'
  | {
      readonly width: number;
      readonly height: number;
      readonly depthOrArrayLayers?: number | undefined;
    };

export interface GraphTextureDescriptor {
  readonly format: TextureFormat;
  readonly size: GraphExtent;
  readonly mipLevelCount?: number | undefined;
  readonly sampleCount?: number | undefined;
  readonly dimension?: GPUTextureDimension | undefined;
  readonly viewFormats?: readonly TextureFormat[] | undefined;
}

export interface ImportedTextureDescriptor extends GraphTextureDescriptor {
  readonly usage: number;
}

export interface GraphTextureViewDescriptor {
  readonly label?: string | undefined;
  readonly format?: TextureFormat | undefined;
  readonly dimension?: GPUTextureViewDimension | undefined;
  readonly aspect?: GPUTextureAspect | undefined;
  readonly baseMipLevel?: number | undefined;
  readonly mipLevelCount?: number | undefined;
  readonly baseArrayLayer?: number | undefined;
  readonly arrayLayerCount?: number | undefined;
}

export type ImportedTextureViewResolver<FrameCtx> = (frame: FrameCtx) => TextureView;

export interface GraphBufferDescriptor {
  readonly size: number;
  readonly mappedAtCreation?: boolean | undefined;
}

export interface ImportedBufferDescriptor extends GraphBufferDescriptor {
  readonly usage: number;
}

export type GraphBufferAccess =
  | 'uniform-read'
  | 'storage-read'
  | 'storage-write'
  | 'storage-read-write'
  | 'indirect-read'
  | 'vertex-read'
  | 'index-read'
  | 'copy-src'
  | 'copy-dst';

export type GraphTextureAccess =
  | 'sampled-read'
  | 'storage-read'
  | 'storage-write'
  | 'storage-read-write'
  | 'color-attachment'
  | 'depth-stencil-read'
  | 'depth-stencil-write'
  | 'copy-src'
  | 'copy-dst';

export type GraphAccess =
  | { readonly resource: GraphBuffer; readonly usage: GraphBufferAccess }
  | { readonly resource: GraphTextureView; readonly usage: GraphTextureAccess };

export interface GraphResourceResolver {
  buffer(resource: GraphBuffer): Result<Buffer, RenderGraphError>;
  texture(resource: GraphTexture): Result<Texture, RenderGraphError>;
  textureView(resource: GraphTextureView): Result<TextureView, RenderGraphError>;
}

export interface RasterColorAttachment<FrameCtx> {
  readonly view: GraphTextureView;
  readonly resolveTarget?: GraphTextureView | undefined;
  readonly clearValue?: GPUColor | ((frame: FrameCtx) => GPUColor) | undefined;
  readonly loadOp: GPULoadOp;
  readonly storeOp: GPUStoreOp;
  readonly depthSlice?: number | undefined;
}

export interface RasterDepthStencilAttachment {
  readonly view: GraphTextureView;
  readonly depthClearValue?: number | undefined;
  readonly depthLoadOp?: GPULoadOp | undefined;
  readonly depthStoreOp?: GPUStoreOp | undefined;
  readonly depthReadOnly?: boolean | undefined;
  readonly stencilClearValue?: number | undefined;
  readonly stencilLoadOp?: GPULoadOp | undefined;
  readonly stencilStoreOp?: GPUStoreOp | undefined;
  readonly stencilReadOnly?: boolean | undefined;
}

export interface RasterGraphPass<FrameCtx> {
  readonly accesses: readonly GraphAccess[];
  readonly colorAttachments: readonly RasterColorAttachment<FrameCtx>[];
  readonly depthStencilAttachment?: RasterDepthStencilAttachment | undefined;
  readonly executeIf?: ((frame: FrameCtx) => boolean) | undefined;
  encode(context: {
    readonly pass: RhiRenderPassEncoder;
    readonly frame: FrameCtx;
    readonly resources: GraphResourceResolver;
  }): void;
}

export interface ComputeGraphPass<FrameCtx> {
  readonly accesses: readonly GraphAccess[];
  readonly executeIf?: ((frame: FrameCtx) => boolean) | undefined;
  readonly begin?: ((frame: FrameCtx) => ComputePassDescriptor) | undefined;
  readonly onBeginError?: ((frame: FrameCtx, cause: unknown) => void) | undefined;
  encode(context: {
    readonly pass: RhiComputePassEncoder;
    readonly frame: FrameCtx;
    readonly resources: GraphResourceResolver;
  }): void;
  readonly after?: ((frame: FrameCtx) => void) | undefined;
}

export interface CopyGraphPass<FrameCtx> {
  readonly accesses: readonly GraphAccess[];
  readonly executeIf?: ((frame: FrameCtx) => boolean) | undefined;
  encode(context: {
    readonly encoder: RhiCommandEncoder;
    readonly frame: FrameCtx;
    readonly resources: GraphResourceResolver;
  }): void;
}

export type GraphPass<FrameCtx> =
  | { readonly kind: 'raster'; readonly descriptor: RasterGraphPass<FrameCtx> }
  | { readonly kind: 'compute'; readonly descriptor: ComputeGraphPass<FrameCtx> }
  | { readonly kind: 'copy'; readonly descriptor: CopyGraphPass<FrameCtx> };

export interface GraphAccessInfo {
  readonly resource: string;
  readonly usage: GraphBufferAccess | GraphTextureAccess;
}

export interface CompiledRenderGraphInfo {
  readonly passes: readonly {
    readonly name: string;
    readonly kind: GraphPassKind;
    readonly executionIndex: number;
    readonly accesses: readonly GraphAccessInfo[];
    readonly dependencies: readonly string[];
  }[];
  readonly resources: readonly {
    readonly label: string;
    readonly kind: GraphResourceKind;
    readonly origin: GraphResourceOrigin;
    readonly firstUse: number | null;
    readonly lastUse: number | null;
    readonly derivedUsage: number;
  }[];
}

export interface RenderGraphFrame {
  readonly encoder: RhiCommandEncoder;
}

export interface RenderGraphPassExecution {
  readonly name: string;
  readonly kind: GraphPassKind;
  readonly executionIndex: number;
}

export type RenderGraphPassRunner = (pass: RenderGraphPassExecution, encode: () => void) => void;

export interface RenderGraphCompileOptions {
  readonly device: RhiDevice;
  readonly surfaceSize: { readonly width: number; readonly height: number };
}

export interface CompiledRenderGraph<FrameCtx extends RenderGraphFrame> {
  execute(frame: FrameCtx, runPass?: RenderGraphPassRunner): Result<void, RenderGraphError>;
  inspect(): CompiledRenderGraphInfo;
  retire(): Promise<Result<void, RenderGraphError>>;
}

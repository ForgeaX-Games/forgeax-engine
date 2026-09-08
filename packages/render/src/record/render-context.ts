import type { AssetRegistry, DynamicTextureStore } from '@forgeax/engine-assets-runtime';
import type { World } from '@forgeax/engine-ecs';
import type { VertexLayoutProjection } from '@forgeax/engine-geometry';
import type { Profiler } from '@forgeax/engine-profiler';
import type {
  BindGroup,
  BindGroupLayout,
  Buffer,
  ComputePipeline,
  PipelineLayout,
  Result,
  RhiCanvasContext,
  RhiDevice,
  RhiError,
  RenderPipeline as RhiRenderPipeline,
  Sampler,
  Texture,
  TextureFormat,
  TextureView,
} from '@forgeax/engine-rhi';
import type { MaterialRuntimeArtifact } from '@forgeax/engine-shader';
import type {
  MaterialRenderState,
  ParamSchemaEntry,
  PassKind,
  PrimitiveTopology,
  VertexAttributeMap,
} from '@forgeax/engine-types';
import type { MaterialRenderProjection } from '../assembly/material/assembly';
import type { DeviceScope } from '../device/device-scope';
import type { MeshGpuHandles } from '../device/gpu-residency';
import type { EngineMetrics } from '../engine-metrics';
import type { RenderFeatureHost } from '../features/host';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import type { SkylightFallback } from '../ibl/skylight-bind-group';
import type { HealthListenerRegistry, RhiErrorListenerRegistry } from '../lifecycle';
import type { StandardProfile } from '../pipeline/standard-profile';
import type { PipelineBuilderShaderModuleFactory } from '../pipeline-builder';
import type { PointsLinesInspection } from '../points-lines/inspection';
import type { PointsLinesRecordPlan } from '../points-lines/record';

export interface PointsLinesRecordSubmission {
  readonly plan: PointsLinesRecordPlan;
  readonly vertexBuffer: Buffer;
  readonly indexBuffer: Buffer;
  readonly layoutProjection: VertexLayoutProjection;
}

import type {
  RenderDebugOverlay,
  RenderPipelineContext,
  RenderRecordPhase,
} from '../render-contract';
import type {
  DispatchEntry,
  MaterialSnapshot,
  SkyboxSnapshot,
  SkylightSnapshot,
} from '../render-system-extract';
import type { SkinPaletteAllocator } from '../systems/skin-palette-allocator';
import type {
  BindGroupCounts,
  DispatchCounts,
  MaterialBgAssemblyCacheEntry,
  RenderFrameState,
  ValidatedRenderable,
} from './frame-snapshot';
import type { FoldDispatchPlan } from './mesh-ssbo';

export interface RenderSystemRuntime {
  readonly device: RhiDevice;
  readonly deviceScope: DeviceScope;
  readonly errorRegistry: RhiErrorListenerRegistry;
  readonly debugOverlay?: RenderDebugOverlay | undefined;
  readonly healthRegistry: HealthListenerRegistry;
  readonly getMaterialProjection?: (materialGuid: string) => MaterialRenderProjection | undefined;
  readonly getMaterialArtifact?: (specializationKey: string) => MaterialRuntimeArtifact | undefined;
  readonly getMaterialShaderPipeline?: (
    materialShaderId: string,
    isHdr: boolean,
    renderState?: MaterialRenderState,
    topology?: PrimitiveTopology,
    indexFormat?: 'uint16' | 'uint32',
    variantSet?: string,
    passKind?: PassKind,
    meshAttributes?: VertexAttributeMap,
    sampleCount?: number,
    colorFormatOverride?: GPUTextureFormat,
    shaderUvSetCount?: number,
    depthFormatOverride?: GPUTextureFormat | null,
    vertexLayout?: string,
    vertexLayoutProjection?: VertexLayoutProjection,
  ) => RhiRenderPipeline | null;
  readonly getMaterialShaderBindingContract?: (
    materialShaderId: string,
  ) => 'group-0' | 'group-0-resource' | 'view-only' | 'view-and-scene-depth' | 'render-material';
  readonly getParamSchema?: (materialShaderId: string) => readonly ParamSchemaEntry[] | undefined;
  readonly getMaterialBindGroupLayout?: (materialShaderId: string) => BindGroupLayout | undefined;
  readonly metrics: EngineMetrics;
  readonly lookupPostProcess?: (
    id: string,
  ) => import('../fullscreen-post-process-pass').PostProcessShaderEntry | undefined;
  readonly getPostProcessParamsBuffer?: (id: string) => Buffer | undefined;
  readonly getPostProcessPipeline?: (
    id: string,
    bgl: BindGroupLayout,
    colorFormat: GPUTextureFormat,
  ) => RhiRenderPipeline | null;
  readonly dynamicTextureStore?: DynamicTextureStore | undefined;
}

/** Renderer-owned bridge from retained Points/Lines facts into main geometry. */
export interface PointsLinesRecordOwner {
  prepare(entry: ValidatedRenderable, clustered: boolean): PointsLinesRecordSubmission | undefined;
  beginFrame(): void;
  resetForDeviceLoss(): void;
  inspections(): readonly PointsLinesInspection[];
}

export interface PerPassResources {
  depthTexture: Texture | null;
  depthTextureView: TextureView | null;
  depthTextureWidth: number;
  depthTextureHeight: number;
  configured: boolean;
  hdrColorTexture: Texture | null;
  hdrColorView: TextureView | null;
  hdrDepthTexture: Texture | null;
  hdrDepthView: TextureView | null;
  hdrTextureWidth: number;
  hdrTextureHeight: number;
  hdrDepthSampleCount: number;
  readonly fxaaPipeline: RhiRenderPipeline | null;
  readonly fxaaBindGroupLayout: BindGroupLayout | null;
  readonly fxaaSampler: Sampler | null;
  msaaColorTexture: Texture | null;
  msaaColorView: TextureView | null;
  msaaSpriteColorTexture: Texture | null;
  msaaSpriteColorView: TextureView | null;
  msaaDepthTexture: Texture | null;
  msaaDepthView: TextureView | null;
  msaaTextureWidth: number;
  msaaTextureHeight: number;
  hdrColorMsaaTexture: Texture | null;
  hdrColorMsaaView: TextureView | null;
  readonly skyboxPipeline: RhiRenderPipeline | null;
  readonly skyboxPipelineMsaa: RhiRenderPipeline | null;
  readonly skyboxBindGroupLayout: BindGroupLayout | null;
  readonly skyboxSampler: Sampler | null;
  readonly skyboxRotationBuffer: Buffer | null;
  readonly bloomBrightPipeline: RhiRenderPipeline | null;
  readonly bloomBlurHPipeline: RhiRenderPipeline | null;
  readonly bloomBlurVPipeline: RhiRenderPipeline | null;
  readonly bloomCompositePipeline: RhiRenderPipeline | null;
  readonly bloomBrightBindGroupLayout: BindGroupLayout | null;
  readonly bloomBlurBindGroupLayout: BindGroupLayout | null;
  readonly bloomCompositeBindGroupLayout: BindGroupLayout | null;
  readonly bloomSampler: Sampler | null;
  readonly bloomBrightParamsBuffer: Buffer | null;
  readonly bloomBlurHParamsBuffer: Buffer | null;
  readonly bloomBlurVParamsBuffer: Buffer | null;
  readonly bloomCompositeParamsBuffer: Buffer | null;
  bloomBrightTexture: Texture | null;
  bloomBrightView: TextureView | null;
  bloomBrightWidth: number;
  bloomBrightHeight: number;
  bloomBlurHTexture: Texture | null;
  bloomBlurHView: TextureView | null;
  bloomBlurHWidth: number;
  bloomBlurHHeight: number;
  bloomBlurVTexture: Texture | null;
  bloomBlurVView: TextureView | null;
  bloomBlurVWidth: number;
  bloomBlurVHeight: number;
  ssaoCalcPipeline: RhiRenderPipeline | null;
  ssaoBlurPipeline: RhiRenderPipeline | null;
  ssaoBgl: BindGroupLayout | null;
  ssaoFilteringSampler: Sampler | null;
  ssaoDepthSampler: Sampler | null;
  ssaoFallbackRawView: TextureView | null;
  shadowTexture: Texture | null;
  shadowMapSize: number;
  shadowCascadeCount: number;
  shadowSampler: Sampler | null;
  shadowLightSpaceMatrix: Float32Array | null;
  shadowCsmLightViewProj: Float32Array | null;
  shadowCsmSelection: {
    readonly viewMatrix: Float32Array;
    readonly splitPlanes: Float32Array;
  } | null;
}

export interface PipelineState {
  readonly meshes: ReadonlyMap<number, MeshGpuHandles>;
  readonly format: TextureFormat;
  readonly colorAttachmentFormat: TextureFormat;
  readonly viewBindGroupLayout: BindGroupLayout;
  readonly materialBindGroupLayout: BindGroupLayout;
  readonly meshBindGroupLayout: BindGroupLayout;
  readonly viewUniformBuffer: Buffer;
  readonly pointsLinesViewBuffer?: Buffer;
  readonly shadowCasterCascadeBuffer: Buffer;
  readonly materialUniformBuffer: { readonly buffer: Buffer; readonly sizeInBytes: number };
  readonly meshStorageBuffer: { readonly buffer: Buffer; readonly sizeInBytes: number };
  readonly pointLightsBuffer: Buffer;
  readonly spotLightsBuffer: Buffer;
  readonly instancesBindGroupLayout: BindGroupLayout;
  readonly identityInstanceBuffer: Buffer;
  readonly defaultSampler: Sampler;
  readonly nearestSampler: Sampler;
  readonly fallbackTextureView: TextureView;
  readonly unlitPipeline: RhiRenderPipeline | null;
  readonly standardPipeline: RhiRenderPipeline | null;
  readonly unlitPipelineMsaa: RhiRenderPipeline | null;
  readonly unlitPipelineHdrMsaa: RhiRenderPipeline | null;
  readonly pbrPipelineLayout: PipelineLayout | null;
  readonly hdrpPbrPipelineLayout: PipelineLayout | null;
  readonly hdrpClusterMembershipPipeline: ComputePipeline | null;
  readonly hdrpClusterMembershipBindGroupLayout: BindGroupLayout | null;
  readonly pbrSkinPipelineLayout: PipelineLayout | null;
  readonly pbrSkinMeshBindGroupLayout: BindGroupLayout | null;
  readonly skinPaletteAllocator: SkinPaletteAllocator | null;
  readonly defaultWhiteTextureView: TextureView;
  readonly defaultNormalTextureView: TextureView;
  readonly unlitPipelineHdr: RhiRenderPipeline | null;
  readonly shadowFallbackTextureView: TextureView;
  readonly shadowAtlasFallbackTextureView: TextureView;
  readonly shadowParamsBuffer: Buffer;
  readonly skylightFallback: SkylightFallback | null;
  readonly perPassResources: PerPassResources;
}

export interface RenderSystemInternals extends RenderSystemRuntime {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  readonly standardProfile?: StandardProfile | undefined;
  readonly standardPipeline: RenderFrameState['activePipeline'];
  readonly featureHost?: RenderFeatureHost | undefined;
  readonly shaderModuleFactory?: PipelineBuilderShaderModuleFactory;
  readonly profiler?: Profiler | undefined;
  readonly context: RhiCanvasContext | null;
  readonly getPipelineState: () => PipelineState | null;
  readonly assets: AssetRegistry;
  readonly gpuStore: import('../device/gpu-residency').GpuResidencyCache;
  readonly growMeshSsbo?:
    | ((neededSlots: number) =>
        | { readonly ok: true }
        | {
            readonly ok: false;
            readonly code: 'mesh-ssbo-ceiling-reached' | 'mesh-ssbo-capacity-exceeded';
            readonly degradedToSlotCount: number;
          })
    | undefined;
  readonly meshSsboState?: { readonly slotCount: number } | undefined;
  readonly buildPostProcessPipeline?:
    | ((
        entry: import('../fullscreen-post-process-pass').PostProcessShaderEntry,
        bgl: BindGroupLayout,
        colorFormat: GPUTextureFormat,
        label: string,
      ) => RhiRenderPipeline | null)
    | undefined;
}

export interface _StandardForwardSceneView {
  readonly assets: AssetRegistry;
  readonly store: import('../device/gpu-residency').GpuResidencyCache;
  readonly pipelineState: PipelineState;
  readonly runtime: RenderSystemRuntime;
  readonly validated: readonly ValidatedRenderable[];
  readonly validatedOrdered: readonly ValidatedRenderable[];
  readonly viewBindGroup: BindGroup | null;
  readonly meshBindGroup: BindGroup | null;
  readonly frameState: RenderFrameState;
  readonly dispatchCounts: DispatchCounts;
  readonly bindGroupCounts: BindGroupCounts;
  readonly skylight: SkylightSnapshot | undefined;
  readonly skylightCount: number;
  readonly skybox: SkyboxSnapshot | undefined;
  readonly profilePhase?: <T>(phase: RenderRecordPhase, action: () => T) => T;
  readonly directionalShadowCacheReuse: boolean;
  readonly world: World;
  readonly gpuDrivenEntityKeys: ReadonlySet<number>;
  readonly tonemapActive: boolean;
  readonly geometryColorView: TextureView | null;
  readonly geometryDepthView: TextureView | null;
  readonly geometryDepthKey: string | null;
  readonly skyboxActive: boolean;
  readonly splitLdrSprite: boolean;
  readonly ldrSpritePassView: TextureView | null;
  readonly transparentColorFormat?: GPUTextureFormat;
  readonly dispatch: readonly DispatchEntry[];
  readonly hdrpClusterBindGroup: BindGroup | null;
  readonly hdrpClusterMembershipBindGroup: BindGroup | null;
  readonly foldDispatchPlan: FoldDispatchPlan | null;
  readonly materialSlotIndices: readonly (readonly number[])[];
  readonly materialSlots: readonly MaterialSnapshot[];
  readonly materialSlotOwners: readonly number[];
  readonly materialSlotCount: number;
  readonly pointsLines: PointsLinesRecordOwner | undefined;
  readonly materialBgAssemblyCache: Map<string, MaterialBgAssemblyCacheEntry>;
  materialUboPayloadCache?: {
    readonly materialSlots: readonly MaterialSnapshot[];
    readonly materialSlotCount: number;
    readonly payload: Uint8Array;
  };
  hdrpSsaoBlurredView?: TextureView;
}

export type _InternalRenderPipelineContext = RenderPipelineContext & _StandardForwardSceneView;

export type RecordProfileRunner = <T>(phase: RenderRecordPhase, action: () => T) => T;

export const STANDARD_PBR_UBO_SIZE = 304;
export const MATERIAL_PER_ENTITY_STRIDE = 512;

export type SwapChainFormatPair = {
  readonly storage: GPUTextureFormat;
  readonly view: GPUTextureFormat;
  readonly fallbackReason?: 'preferred-canvas-format-missing';
};

export type SurfaceBackendKind = 'webgpu' | 'wgpu-native' | 'wgpu-webgl2' | 'null';

export function resolveSurfaceFormatPair(
  backendKind: SurfaceBackendKind,
  storage: GPUTextureFormat,
  view: GPUTextureFormat,
): SwapChainFormatPair {
  return backendKind === 'wgpu-webgl2' ? { storage: view, view } : { storage, view };
}

export function configureSurface(
  context: RhiCanvasContext,
  device: RhiDevice,
  format: TextureFormat,
  colorAttachmentFormat: TextureFormat,
): Result<void, RhiError> {
  const backendKind = device.caps?.backendKind ?? 'webgpu';
  const isWebGl2 = backendKind === 'wgpu-webgl2';
  const surfaceFormats = resolveSurfaceFormatPair(
    backendKind,
    format as GPUTextureFormat,
    colorAttachmentFormat as GPUTextureFormat,
  );
  const supportsTextureBinding = device.caps?.storageBuffer ?? true;
  return context.configure({
    device,
    format: surfaceFormats.storage,
    alphaMode: isWebGl2 ? 'opaque' : 'premultiplied',
    usage:
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      (supportsTextureBinding ? GPU_TEXTURE_USAGE_TEXTURE_BINDING : 0) |
      (isWebGl2 ? 0 : GPU_TEXTURE_USAGE_COPY_SRC),
    ...(!isWebGl2 ? { viewFormats: [surfaceFormats.view] } : {}),
  });
}

export function selectSwapChainFormat(storageBufferCapable: boolean): SwapChainFormatPair {
  if (!storageBufferCapable) return { storage: 'rgba8unorm', view: 'rgba8unorm-srgb' };
  const nav = (
    globalThis as { navigator?: { gpu?: { getPreferredCanvasFormat?: () => GPUTextureFormat } } }
  ).navigator;
  const gpu = nav?.gpu;
  const getPreferred = gpu?.getPreferredCanvasFormat;
  if (gpu !== undefined && typeof getPreferred === 'function') {
    const storage = getPreferred.call(gpu);
    const view =
      storage === 'rgba8unorm'
        ? 'rgba8unorm-srgb'
        : storage === 'bgra8unorm'
          ? 'bgra8unorm-srgb'
          : storage;
    return { storage, view };
  }
  return {
    storage: 'rgba8unorm',
    view: 'rgba8unorm-srgb',
    fallbackReason: 'preferred-canvas-format-missing',
  };
}

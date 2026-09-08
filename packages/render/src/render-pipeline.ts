// @forgeax/engine-render - typed render-pipeline topology contract.
//
// `RenderPipeline` is the typed topology contribution used by the Standard host.
// The host owns the single active pipeline identity and its lifecycle; producers
// contribute graph declarations through this interface instead of publishing a
// second renderer authority.
//
// Naming note (requirements line 155): `RenderPipeline` here is the forgeax engine
// concept name. The RHI GPU `RenderPipeline` handle (`@forgeax/engine-rhi`) is a
// separate, internal opaque-handle type distinguished by module path (AGENTS.md RHI
// form rules - "opaque handles distinguished by module path"); it is not exposed to
// AI users. Files importing both alias the RHI one locally.
//
// Pipelines declare topology once through a typed builder. The renderer compiles,
// executes, retires, finishes, and submits the resulting graph.

import type {
  ColorValueDomain,
  GraphAccess,
  GraphResourceResolver,
  GraphTexture,
  GraphTextureDescriptor,
  GraphTextureView,
  GraphTextureViewDescriptor,
  RenderGraphBuilder,
  RenderGraphError,
  RenderGraphFrame,
} from '@forgeax/engine-render-graph';
import type { BindGroup, RhiError, RhiRenderPassEncoder, TextureFormat } from '@forgeax/engine-rhi';
import { ok, type Result } from '@forgeax/engine-types';
import type { Tonemap } from './components/camera';
import type { RenderError } from './errors/render';
import type { RenderFeatureTargetKind } from './features/targets';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
} from './gpu-texture-usage';
import type { StandardProfile } from './pipeline/standard-profile';
import type { RenderPipelineContext } from './render-contract';

export type { RenderPipelineContext } from './render-contract';

export type RenderColorDomain = 'linearHdr' | 'linearLdr' | 'displayEncoded';

export interface ToneOutputContract {
  readonly input: RenderColorDomain;
  readonly toneMapped: boolean;
  readonly mapped: 'linearLdr';
  readonly finalCapture: 'displayEncoded';
  readonly exposureStage: 'linearHdr' | 'none';
}

export type RenderPostStageName = 'transparent-blend' | 'bloom' | 'tone' | 'fxaa' | 'output';
export type RenderPostDomainStage = readonly [
  RenderPostStageName,
  ColorValueDomain,
  ColorValueDomain,
];

/**
 * Single post-stage domain contract shared by the Standard lighting lanes.
 * The selected scene domain for transparent geometry is explicit; every later
 * stage follows the same linear blend, tone, anti-alias, and output sequence.
 */
export function resolvePostColorDomainContract(
  sceneDomain: 'linear-ldr' | 'linear-hdr',
): readonly RenderPostDomainStage[] {
  const scene: ColorValueDomain = sceneDomain;
  return [
    ['transparent-blend', scene, scene],
    ['bloom', 'linear-hdr', 'linear-hdr'],
    ['tone', 'linear-hdr', 'linear-ldr'],
    ['fxaa', 'linear-ldr', 'linear-ldr'],
    ['output', 'linear-ldr', 'display-encoded'],
  ];
}

/**
 * Describe the built-in output stages without moving color-domain policy into
 * a mode name. Tone-enabled cameras render HDR, apply exposure and the
 * selected curve in the fullscreen pass, then reach the encoded surface.
 */
export function resolveToneOutputContract(tonemap: Tonemap): ToneOutputContract {
  if (tonemap === 'none') {
    return {
      input: 'linearLdr',
      toneMapped: false,
      mapped: 'linearLdr',
      finalCapture: 'displayEncoded',
      exposureStage: 'none',
    };
  }
  return {
    input: 'linearHdr',
    toneMapped: true,
    mapped: 'linearLdr',
    finalCapture: 'displayEncoded',
    exposureStage: 'linearHdr',
  };
}

/** Stable facts that may change graph topology and therefore its compiled identity. */
export interface RenderPipelineTopology {
  readonly pipelineId: string;
  readonly standardProfile?: StandardProfile | undefined;
  readonly config: import('@forgeax/engine-types').RenderPipelineAsset['config'];
  readonly surface: {
    readonly width: number;
    readonly height: number;
    readonly storageFormat: import('@forgeax/engine-rhi').TextureFormat;
    readonly viewFormat: import('@forgeax/engine-rhi').TextureFormat;
  };
  readonly camera: Pick<RenderPipelineContext['camera'], 'tonemap' | 'antialias' | 'bloom'>;
  readonly shadow: {
    readonly mapSize: number;
    readonly cascadeCount: 1 | 2 | 3 | 4;
    readonly pointCount: number;
    readonly pointFaceSize: number;
    readonly spotCount: number;
  };
  readonly lane: {
    readonly compute: boolean;
    readonly storageBuffer: boolean;
    readonly multisample: boolean;
    readonly maxColorAttachments: number;
  };
  readonly featureTopologySignature: string;
  readonly gpuDrivenTopologySignature: string;
}

export interface RenderPipelineFrame extends RenderPipelineContext, RenderGraphFrame {}

export interface RenderPipelineTarget {
  readonly texture: GraphTexture;
  readonly view: GraphTextureView;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
  readonly resolveTarget?: GraphTextureView | undefined;
}

export function createRenderPipelineTarget(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  label: string,
  descriptor: GraphTextureDescriptor,
  viewDescriptor: GraphTextureViewDescriptor = {},
): Result<RenderPipelineTarget, RenderGraphError> {
  const texture = graph.createTexture(label, descriptor);
  if (!texture.ok) return texture;
  const view = graph.view(texture.value, { label: `${label}.view`, ...viewDescriptor });
  if (!view.ok) return view;
  return ok({
    texture: texture.value,
    view: view.value,
    format: viewDescriptor.format ?? descriptor.format,
    sampleCount: descriptor.sampleCount === 4 ? 4 : 1,
  });
}

export function importRenderPipelineSurface(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  topology: RenderPipelineTopology,
): Result<
  { readonly display: RenderPipelineTarget; readonly storage: RenderPipelineTarget },
  RenderGraphError
> {
  const texture = graph.importTexture(
    'surface',
    {
      format: topology.surface.storageFormat,
      size: 'surface',
      usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT | GPU_TEXTURE_USAGE_COPY_SRC,
      viewFormats:
        topology.surface.storageFormat === topology.surface.viewFormat
          ? []
          : [topology.surface.viewFormat],
    },
    (frame) => frame.currentTexture,
  );
  if (!texture.ok) return texture;
  const display = graph.importView(
    texture.value,
    { label: 'surface.display', format: topology.surface.viewFormat },
    (frame) => frame.view,
  );
  if (!display.ok) return display;
  const storage = graph.importView(
    texture.value,
    { label: 'surface.storage', format: topology.surface.storageFormat },
    (frame) => {
      if (topology.surface.storageFormat === topology.surface.viewFormat) return frame.view;
      const resolved = frame.runtime.device.createTextureView(frame.currentTexture, {
        format: topology.surface.storageFormat,
      });
      if (!resolved.ok) throw resolved.error;
      return resolved.value;
    },
  );
  if (!storage.ok) return storage;
  return ok({
    display: {
      texture: texture.value,
      view: display.value,
      format: topology.surface.viewFormat,
      sampleCount: 1,
    },
    storage: {
      texture: texture.value,
      view: storage.value,
      format: topology.surface.storageFormat,
      sampleCount: 1,
    },
  });
}

export interface RenderPipelineFeatureTarget {
  readonly kind: RenderFeatureTargetKind;
  readonly texture: GraphTexture;
  readonly view: GraphTextureView;
  readonly resolveTarget?: GraphTextureView | undefined;
  readonly format: TextureFormat;
  readonly sampleCount: 1 | 4;
}

export interface RenderPipelineGpuDrivenProjection {
  readonly accesses: readonly GraphAccess[];
  encode(
    viewBindGroup: BindGroup,
    pass: RhiRenderPassEncoder,
    resources: GraphResourceResolver,
  ): void;
}

export interface RenderPipelineBuildContext<FrameCtx extends RenderPipelineFrame> {
  readonly graph: RenderGraphBuilder<FrameCtx>;
  projectGpuDriven(target: {
    readonly format: TextureFormat;
    readonly sampleCount: 1 | 4;
  }): Result<RenderPipelineGpuDrivenProjection | undefined, RenderPipelineBuildError>;
  contributeFeatures(
    targets: readonly RenderPipelineFeatureTarget[],
  ): Result<void, RenderPipelineBuildError>;
}

export type RenderPipelineBuildError = RenderGraphError | RenderError | RhiError;

/**
 * Registrable, installable, hot-swappable render topology.
 *
 * `build` declares resources and passes only. The renderer owns compilation,
 * last-known-good replacement, execution, retirement, and the single frame submit.
 * Feature contributions enter through `contributeFeatures`, so compute-produced
 * buffers and later raster reads remain inside the same typed dependency graph.
 */
export interface RenderPipeline<FrameCtx extends RenderPipelineFrame = RenderPipelineFrame> {
  build(
    context: RenderPipelineBuildContext<FrameCtx>,
    topology: RenderPipelineTopology,
  ): Result<void, RenderPipelineBuildError>;
}

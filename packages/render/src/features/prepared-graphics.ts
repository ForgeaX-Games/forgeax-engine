/**
 * Public prepared-graphics vocabulary for producer-owned RenderFeatures.
 *
 * The five prepared kinds are declarative references only: the render owner
 * retains device, resource, graph, recording, and submission ownership.
 */
import {
  err,
  type MaterialRenderState,
  ok,
  type PrimitiveTopology,
  type Result,
} from '@forgeax/engine-types';
import {
  type RenderError,
  RenderFeaturePreparationFailedError,
  RenderFeaturePreparedStateMismatchError,
} from '../errors/render';
import type { RenderFeatureGpuBufferRef } from './prepared-gpu-work';
import type { RenderFeatureTargetHandle } from './targets';
import type { RenderFeaturePreparedStateMismatchDetail } from './types';

/** Closed prepared kinds: pipeline, bindings, vertex/index data, and attachment. */
export type PreparedKind = 'pipeline' | 'bindings' | 'vertex-data' | 'index-data' | 'attachment';

/** Canonical vertex layouts owned by the prepared-graphics host. */
export const RENDER_FEATURE_VERTEX_LAYOUTS = Object.freeze({
  positionSizeColorInstance: 'position-size-color-instance',
  billboardMaterialInstance: 'billboard-material-instance',
  topologySegmentInstance: 'topology-segment-instance',
  meshGeometryMaterialInstance: 'mesh-geometry-material-instance',
} as const);

/**
 * Opaque render-owned state identified by its prepared kind and device generation.
 * A generation change invalidates old references after device recovery or
 * pipeline replacement; features never construct or inspect backend handles.
 * Features may pass this reference back to the render owner but do not receive a
 * device, encoder, backend handle, or submit authority.
 */
export interface RenderFeaturePreparedRef<Kind extends PreparedKind = PreparedKind> {
  readonly kind: Kind;
  readonly generation: number;
}

/** Declarative request for a registered graphics pipeline. */
export interface RenderFeaturePipelineDescriptor {
  readonly shader: string;
  readonly vertexLayout: string;
  readonly colorFormats: readonly string[];
  readonly depthFormat?: string;
  /** Sample count of the target this pipeline will draw into. */
  readonly sampleCount?: 1 | 4;
  /** Primitive topology consumed by the prepared draw. */
  readonly topology?: PrimitiveTopology;
  /** Index scalar format when the topology consumes an index buffer. */
  readonly indexFormat?: 'uint16' | 'uint32';
  /**
   * Declarative raster/depth/blend overrides for this pipeline. The render
   * owner maps this portable material state onto the backend pipeline; a
   * feature never receives a backend pipeline descriptor or device handle.
   */
  readonly renderState?: MaterialRenderState;
}

/** Declarative request for values bound through a prepared pipeline. */
export interface RenderFeatureBindingsDescriptor {
  readonly pipeline: RenderFeaturePreparedRef<'pipeline'>;
  readonly values: Readonly<Record<string, unknown>> & {
    readonly group?: number;
    readonly sceneDepth?: RenderFeatureTargetHandle;
  };
}

/** CPU-owned vertex data and its canonical layout identity. */
export type RenderFeatureVertexDataDescriptor =
  | {
      readonly layout: string;
      readonly data: ArrayBufferView | readonly number[];
      readonly buffer?: never;
    }
  | {
      readonly layout: string;
      readonly buffer: RenderFeatureGpuBufferRef;
      readonly data?: never;
    };

/** CPU-owned or persistent GPU-owned index data and its scalar format. */
export type RenderFeatureIndexDataDescriptor =
  | {
      readonly format: 'uint16' | 'uint32';
      readonly data: Uint16Array | Uint32Array;
      readonly buffer?: never;
    }
  | {
      readonly format: 'uint16' | 'uint32';
      readonly buffer: RenderFeatureGpuBufferRef;
      readonly data?: never;
    };

/**
 * Feature-facing preparation facade. Call these methods during `prepare`, then
 * pass the returned references to `addGraphicsPass` during `contribute`; the
 * render owner retains resource, graph, recording, and submission ownership.
 */
export interface RenderFeatureGraphicsPrepare {
  /** Prepare a registered graphics pipeline without exposing backend state. */
  preparePipeline(
    name: string,
    descriptor: RenderFeaturePipelineDescriptor,
  ): Result<RenderFeaturePreparedRef<'pipeline'>, RenderError>;
  /** Prepare bindings compatible with a prepared pipeline. */
  prepareBindings(
    name: string,
    descriptor: RenderFeatureBindingsDescriptor,
  ): Result<RenderFeaturePreparedRef<'bindings'>, RenderError>;
  /** Prepare vertex data using a canonical layout identity. */
  prepareVertexData(
    name: string,
    descriptor: RenderFeatureVertexDataDescriptor,
  ): Result<RenderFeaturePreparedRef<'vertex-data'>, RenderError>;
  /** Prepare index data for an indexed draw record. */
  prepareIndexData(
    name: string,
    descriptor: RenderFeatureIndexDataDescriptor,
  ): Result<RenderFeaturePreparedRef<'index-data'>, RenderError>;
}

/** A color target declared by a graphics pass. */
export interface RenderFeatureColorAttachment {
  readonly resource: string | RenderFeatureTargetHandle;
  readonly format: string;
  readonly loadOp: 'load' | 'clear';
  readonly storeOp: 'store' | 'discard';
}

/** A depth/stencil target declared by a graphics pass. */
export interface RenderFeatureDepthStencilAttachment {
  readonly resource: string | RenderFeatureTargetHandle;
  readonly format: string;
  readonly depthLoadOp: 'load' | 'clear';
  readonly depthStoreOp: 'store' | 'discard';
}

/** The attachments a graphics pass requires from the render owner. */
export interface RenderFeatureGraphicsPassAttachments {
  readonly colors: readonly RenderFeatureColorAttachment[];
  readonly depthStencil?: RenderFeatureDepthStencilAttachment;
}

/** One vertex slot consumed by a declarative draw record. */
export interface RenderFeatureVertexDataBinding {
  readonly slot: number;
  readonly resource: RenderFeaturePreparedRef<'vertex-data'>;
}

/** Non-indexed draw command. */
export interface RenderFeatureDrawCommand {
  readonly vertexCount: number;
  readonly instanceCount: number;
  readonly firstVertex?: number;
  readonly firstInstance?: number;
}

/** Indexed draw command. */
export interface RenderFeatureIndexedDrawCommand {
  readonly indexCount: number;
  readonly instanceCount: number;
  readonly firstIndex?: number;
  readonly baseVertex?: number;
  readonly firstInstance?: number;
}

export interface RenderFeatureIndirectDrawCommand {
  readonly buffer: RenderFeatureGpuBufferRef;
  readonly offset?: number;
}

/** Index state attached to an indexed draw record. */
export interface RenderFeatureIndexDataBinding {
  readonly resource: RenderFeaturePreparedRef<'index-data'>;
  readonly format: 'uint16' | 'uint32';
}

/** The two supported graphics draw record shapes: vertex-only and indexed. */
export type RenderFeatureDrawRecord =
  | {
      readonly kind: 'draw';
      readonly pipeline: RenderFeaturePreparedRef<'pipeline'>;
      readonly bindings: readonly RenderFeaturePreparedRef<'bindings'>[];
      readonly vertexData: readonly RenderFeatureVertexDataBinding[];
      /** Explicit fullscreen contract: the vertex shader owns vertex_index. */
      readonly vertexLayout?: 'none';
      readonly indexData?: RenderFeatureIndexDataBinding;
      readonly command: RenderFeatureDrawCommand;
    }
  | {
      readonly kind: 'draw-indirect';
      readonly pipeline: RenderFeaturePreparedRef<'pipeline'>;
      readonly bindings: readonly RenderFeaturePreparedRef<'bindings'>[];
      readonly vertexData: readonly RenderFeatureVertexDataBinding[];
      readonly vertexLayout?: 'none';
      readonly indexData?: RenderFeatureIndexDataBinding;
      readonly command: RenderFeatureIndirectDrawCommand;
    }
  | {
      readonly kind: 'draw-indexed';
      readonly pipeline: RenderFeaturePreparedRef<'pipeline'>;
      readonly bindings: readonly RenderFeaturePreparedRef<'bindings'>[];
      readonly vertexData: readonly RenderFeatureVertexDataBinding[];
      readonly vertexLayout?: 'none';
      readonly indexData: RenderFeatureIndexDataBinding | undefined;
      readonly command: RenderFeatureIndexedDrawCommand;
    }
  | {
      readonly kind: 'draw-indexed-indirect';
      readonly pipeline: RenderFeaturePreparedRef<'pipeline'>;
      readonly bindings: readonly RenderFeaturePreparedRef<'bindings'>[];
      readonly vertexData: readonly RenderFeatureVertexDataBinding[];
      readonly vertexLayout?: 'none';
      readonly indexData: RenderFeatureIndexDataBinding | undefined;
      readonly command: RenderFeatureIndirectDrawCommand;
    };

/**
 * Declaration submitted to the existing graph-owned contribution staging.
 * This is a graphics extension of graph-only `addPass`, not a second graph.
 */
export interface RenderFeatureGraphicsPassDescriptor {
  readonly attachments: RenderFeatureGraphicsPassAttachments;
  /** Targets sampled by shaders but not attached for writing in this pass. */
  readonly sampledTargets?: readonly RenderFeatureTargetHandle[];
  readonly draws: readonly RenderFeatureDrawRecord[];
}

/** Graph-owned staging entry for declarative graphics work. */
export interface RenderFeatureGraphicsContributionStaging {
  /** Add one declarative graphics pass while preserving graph ownership. */
  addGraphicsPass(
    name: string,
    descriptor: RenderFeatureGraphicsPassDescriptor,
    options?: import('./graph-contribution').RenderFeaturePassOptions,
  ): Result<void, RenderError>;
}

/**
 * Prepared state projected by the render owner for pure descriptor validation.
 * The generation and opaque references are host facts, not producer-owned GPU
 * state.
 */
export interface RenderFeaturePreparedGraphicsState {
  readonly capabilityAvailable: boolean;
  readonly generation: number;
  readonly attachments: readonly {
    readonly resource: string | RenderFeatureTargetHandle;
    readonly format: string;
  }[];
  readonly pipeline: RenderFeaturePreparedRef | undefined;
  /** All prepared pipelines available to the current graphics pass. */
  readonly pipelines?: readonly RenderFeaturePreparedRef[];
  readonly bindings: readonly RenderFeaturePreparedRef[];
  readonly vertexData: readonly RenderFeaturePreparedRef[];
  readonly indexData: readonly RenderFeaturePreparedRef[];
}

/** Successful validation result consumed by the render host projector. */
export interface RenderFeatureValidatedGraphicsPass {
  readonly acceptedDrawCount: number;
}

function invalid(
  featureIdentity: string,
  stage: 'prepare' | 'contribute',
): Result<never, RenderError> {
  if (stage === 'prepare') {
    return err(
      new RenderFeaturePreparationFailedError(
        featureIdentity,
        -1,
        'validate-prepared-state',
        'pipeline',
        'graphics-state',
        'prepared-state-unavailable',
        'next-frame',
      ),
    );
  }
  const detail: RenderFeaturePreparedStateMismatchDetail = {
    featureIdentity,
    order: -1,
    stage: 'contribute',
    operation: 'validate-graphics-pass',
    resourceKind: 'pipeline',
    reason: 'missing-prepared-state',
    missingResource: 'compatible-prepared-state',
    recovery: 'next-frame',
  };
  return err(new RenderFeaturePreparedStateMismatchError(detail));
}

function preparationFailure(
  featureIdentity: string,
  order: number,
  operation: string,
  resourceKind: PreparedKind,
): Result<never, RenderError> {
  return err(
    new RenderFeaturePreparationFailedError(
      featureIdentity,
      order,
      operation,
      resourceKind,
      'unavailable',
      'prepared-graphics-host-unavailable',
      'next-frame',
    ),
  );
}

function validRef<Kind extends PreparedKind>(
  reference: RenderFeaturePreparedRef<Kind>,
  kind: Kind,
  generation: number,
): boolean {
  return reference.kind === kind && reference.generation === generation;
}

function hasAttachment(
  available: RenderFeaturePreparedGraphicsState['attachments'],
  required: RenderFeatureColorAttachment | RenderFeatureDepthStencilAttachment,
): boolean {
  const requiredResource =
    typeof required.resource === 'string' ? required.resource : required.resource.resource;
  return available.some(
    (attachment) =>
      (typeof attachment.resource === 'string'
        ? attachment.resource
        : attachment.resource.resource) === requiredResource &&
      attachment.format === required.format,
  );
}

function hasPreparedRef(
  available: readonly RenderFeaturePreparedRef[],
  required: RenderFeaturePreparedRef,
): boolean {
  return available.some((reference) => reference === required);
}

function hasValidVertexContract(
  draw: RenderFeatureDrawRecord,
  state: RenderFeaturePreparedGraphicsState,
): boolean {
  if (draw.vertexLayout === 'none') {
    return draw.kind === 'draw' && draw.vertexData.length === 0;
  }
  return (
    draw.vertexData.length > 0 &&
    draw.vertexData.every(
      (binding) =>
        validRef(binding.resource, 'vertex-data', state.generation) &&
        hasPreparedRef(state.vertexData, binding.resource),
    )
  );
}

function hasValidBindings(
  draw: RenderFeatureDrawRecord,
  state: RenderFeaturePreparedGraphicsState,
): boolean {
  return (
    draw.bindings.length > 0 &&
    draw.bindings.every(
      (reference) =>
        validRef(reference, 'bindings', state.generation) &&
        hasPreparedRef(state.bindings, reference),
    )
  );
}

/** Validate a graphics declaration without touching an RHI backend. */
export function validateRenderFeatureGraphicsPass(
  featureIdentity: string,
  descriptor: RenderFeatureGraphicsPassDescriptor,
  state: RenderFeaturePreparedGraphicsState,
): Result<RenderFeatureValidatedGraphicsPass, RenderError> {
  if (!state.capabilityAvailable) return invalid(featureIdentity, 'prepare');
  const pipelines = state.pipelines ?? (state.pipeline === undefined ? [] : [state.pipeline]);
  const hasVertexDraw = descriptor.draws.some((draw) => draw.vertexData.length > 0);
  if (
    pipelines.length === 0 ||
    state.bindings.length === 0 ||
    (hasVertexDraw && state.vertexData.length === 0)
  ) {
    return invalid(featureIdentity, 'prepare');
  }
  if (
    pipelines.some((reference) => !validRef(reference, 'pipeline', state.generation)) ||
    state.bindings.some((reference) => !validRef(reference, 'bindings', state.generation)) ||
    state.vertexData.some((reference) => !validRef(reference, 'vertex-data', state.generation)) ||
    state.indexData.some((reference) => !validRef(reference, 'index-data', state.generation))
  ) {
    return invalid(featureIdentity, 'contribute');
  }
  if (
    descriptor.attachments.colors.some(
      (attachment) => !hasAttachment(state.attachments, attachment),
    ) ||
    (descriptor.attachments.depthStencil !== undefined &&
      !hasAttachment(state.attachments, descriptor.attachments.depthStencil))
  ) {
    return invalid(featureIdentity, 'contribute');
  }

  for (const draw of descriptor.draws) {
    if (
      !validRef(draw.pipeline, 'pipeline', state.generation) ||
      !hasPreparedRef(pipelines, draw.pipeline) ||
      !hasValidBindings(draw, state) ||
      !hasValidVertexContract(draw, state)
    ) {
      return invalid(featureIdentity, 'contribute');
    }
    if (
      (draw.kind === 'draw-indirect' || draw.kind === 'draw-indexed-indirect') &&
      draw.command.buffer.generation !== state.generation
    ) {
      return invalid(featureIdentity, 'contribute');
    }
    if (draw.kind === 'draw-indexed' || draw.kind === 'draw-indexed-indirect') {
      if (
        draw.indexData === undefined ||
        !validRef(draw.indexData.resource, 'index-data', state.generation) ||
        !hasPreparedRef(state.indexData, draw.indexData.resource) ||
        state.indexData.length === 0
      ) {
        return invalid(featureIdentity, 'contribute');
      }
    } else if (draw.indexData !== undefined) {
      return invalid(featureIdentity, 'contribute');
    }
  }
  return ok({ acceptedDrawCount: descriptor.draws.length });
}

/** Create the explicit unavailable facade used until a Host owns prepared state. */
export function createRenderFeatureGraphicsPrepare(
  featureIdentity: string,
  order: number,
): RenderFeatureGraphicsPrepare {
  return {
    preparePipeline: () =>
      preparationFailure(featureIdentity, order, 'prepare-pipeline', 'pipeline'),
    prepareBindings: () =>
      preparationFailure(featureIdentity, order, 'prepare-bindings', 'bindings'),
    prepareVertexData: () =>
      preparationFailure(featureIdentity, order, 'prepare-vertex-data', 'vertex-data'),
    prepareIndexData: () =>
      preparationFailure(featureIdentity, order, 'prepare-index-data', 'index-data'),
  };
}

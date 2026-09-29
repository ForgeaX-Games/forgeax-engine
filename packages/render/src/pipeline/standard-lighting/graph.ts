import type {
  GraphAccess,
  GraphBuffer,
  RenderGraphBuilder,
  RenderGraphError,
} from '@forgeax/engine-render-graph';
import { ok, type Result } from '@forgeax/engine-types';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_STORAGE,
  GPU_BUFFER_USAGE_UNIFORM,
} from '../../gpu-usage';
import { getOrCreateHdrpBuffers, type HdrpBuffers } from '../../hdrp-buffers';
import { BYTES_PER_DIRECT_LIGHT_SLOT } from '../../light-buffer-layout';
import type { _InternalRenderPipelineContext } from '../../record/render-context';
import type { RenderPipelineFrame } from '../../render-pipeline';
import type { StandardTopologyInputValue } from './topology';

/** Graph resources projected from one Standard lighting topology input. */
export interface StandardClusterGraphBuffers {
  readonly lightData: GraphBuffer;
  readonly clusterGrid: GraphBuffer;
  readonly lightIndexList: GraphBuffer;
  readonly clusterUniform: GraphBuffer;
  readonly lightBounds: GraphBuffer;
}

/** Stable graph-time projection; never retain a frame's typed-array payload. */
interface StandardClusterGraphDescriptor {
  readonly grid: { readonly x: number; readonly y: number; readonly z: number };
}

function projectDescriptor(input: StandardTopologyInputValue): StandardClusterGraphDescriptor {
  const { x, y, z } = input.prepared.layout.grid;
  return { grid: { x, y, z } };
}

function resolveBuffers(
  frame: RenderPipelineFrame,
  descriptor: StandardClusterGraphDescriptor,
): HdrpBuffers {
  const internal = frame as _InternalRenderPipelineContext;
  const buffers = getOrCreateHdrpBuffers(internal.runtime, descriptor.grid);
  if (buffers === null) throw new Error('Standard persistent buffer allocation failed');
  return buffers;
}

/** Resolve membership execution from the frame's current prepared payload. */
export function shouldExecuteStandardClusterMembershipPass(frame: RenderPipelineFrame): boolean {
  const standardLighting = (frame as _InternalRenderPipelineContext).standardLighting;
  return (
    standardLighting?.kind === 'clustered' &&
    standardLighting.transport.kind === 'compute-storage' &&
    standardLighting.prepared.local.length > 0
  );
}

/** Import the shared Standard Cluster buffers with sizes derived from layout. */
export function importStandardClusterBuffers(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: StandardTopologyInputValue,
): Result<StandardClusterGraphBuffers | null, RenderGraphError> {
  if (input.kind === 'no-local-lights') return ok(null);
  const layout = input.prepared.layout;
  const descriptor = projectDescriptor(input);
  const usage = GPU_BUFFER_USAGE_STORAGE | GPU_BUFFER_USAGE_COPY_DST;
  const lightData = graph.importBuffer(
    'hdrp-light-data',
    { size: layout.lightDataSlotCount * BYTES_PER_DIRECT_LIGHT_SLOT, usage },
    (frame) => resolveBuffers(frame, descriptor).lightDataBuffer,
  );
  if (!lightData.ok) return lightData;
  const clusterGrid = graph.importBuffer(
    'hdrp-cluster-grid',
    { size: layout.clusterGridU32Length * 4, usage },
    (frame) => resolveBuffers(frame, descriptor).clusterGridBuffer,
  );
  if (!clusterGrid.ok) return clusterGrid;
  const lightIndexList = graph.importBuffer(
    'hdrp-light-index-list',
    { size: layout.lightIndexListCapacity * 4, usage },
    (frame) => resolveBuffers(frame, descriptor).lightIndexListBuffer,
  );
  if (!lightIndexList.ok) return lightIndexList;
  const clusterUniform = graph.importBuffer(
    'hdrp-cluster-uniform',
    { size: 32, usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST },
    (frame) => resolveBuffers(frame, descriptor).clusterUniformBuffer,
  );
  if (!clusterUniform.ok) return clusterUniform;
  const lightBounds = graph.importBuffer(
    'hdrp-light-bounds',
    { size: layout.lightBoundsInt32Length * 4, usage },
    (frame) => resolveBuffers(frame, descriptor).lightBoundsBuffer,
  );
  if (!lightBounds.ok) return lightBounds;
  return ok({
    lightData: lightData.value,
    clusterGrid: clusterGrid.value,
    lightIndexList: lightIndexList.value,
    clusterUniform: clusterUniform.value,
    lightBounds: lightBounds.value,
  });
}

/** Accesses used by raster consumers of the shared Cluster payload. */
export function standardClusterReadAccesses(
  buffers: StandardClusterGraphBuffers,
): readonly GraphAccess[] {
  return [
    { resource: buffers.lightData, usage: 'storage-read' },
    { resource: buffers.clusterGrid, usage: 'storage-read' },
    { resource: buffers.lightIndexList, usage: 'storage-read' },
    { resource: buffers.clusterUniform, usage: 'uniform-read' },
  ];
}

/**
 * Add the sole GPU membership producer. CPU membership is already materialized
 * in PreparedStandardLighting and therefore contributes no second pass.
 */
export function addStandardClusterMembershipPass(
  graph: RenderGraphBuilder<RenderPipelineFrame>,
  input: StandardTopologyInputValue,
  buffers: StandardClusterGraphBuffers,
): Result<void, RenderGraphError> {
  if (input.kind === 'no-local-lights') return ok(undefined);
  if (input.transport.kind !== 'compute-storage') return ok(undefined);
  const descriptor = projectDescriptor(input);
  return graph.addComputePass('cluster-membership-producer', {
    accesses: [
      { resource: buffers.clusterGrid, usage: 'storage-read' },
      { resource: buffers.clusterUniform, usage: 'uniform-read' },
      { resource: buffers.lightBounds, usage: 'storage-read' },
      { resource: buffers.lightIndexList, usage: 'storage-write' },
    ],
    // Keep the clustered graph/ABI stable for a directional-only frame, but
    // do not require a producer bind group when there is no local corpus to
    // bin.  The zero-length prepared payload is already the complete result;
    // executing this pass would only turn an otherwise valid frame into a
    // null-backend encode failure.
    executeIf: shouldExecuteStandardClusterMembershipPass,
    encode: ({ pass, frame }) => {
      const internal = frame as _InternalRenderPipelineContext;
      const pipeline = internal.pipelineState.hdrpClusterMembershipPipeline;
      const bindings = internal.hdrpClusterMembershipBindGroup;
      if (pipeline === null || bindings === null) {
        throw new Error(
          'standard-cluster-transport-unavailable: selected compute Cluster producer is not ready',
        );
      }
      const { x, y, z } = descriptor.grid;
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindings);
      pass.dispatchWorkgroups(Math.ceil((x * y * z) / 64));
    },
  });
}

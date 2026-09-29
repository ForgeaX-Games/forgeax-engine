export interface OcclusionBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface OcclusionPassIdentity {
  readonly primitiveSlot: number;
  readonly slotGeneration: number;
}

export interface OcclusionPassPlan {
  readonly after: string;
  readonly depth: { readonly resource: string; readonly usage: 'depth-read-only' };
  readonly color: { readonly resource: string; readonly usage: 'not-written' };
  readonly proxyBounds: OcclusionBounds;
  readonly queryIndex: number;
  readonly identity?: OcclusionPassIdentity;
  readonly resolve: { readonly queryIndex: number; readonly bytes: number };
  readonly copy: { readonly asynchronous: true; readonly bytes: number };
  readonly writesColor: false;
  readonly writesDepth: false;
  readonly submitCount: 1;
  readonly mapSameFrame: false;
}

export interface OcclusionPassInput {
  readonly opaquePass: string;
  readonly depthResource: string;
  readonly colorResource: string;
  readonly bounds: OcclusionBounds | undefined;
  readonly queryIndex: number;
  readonly identity?: OcclusionPassIdentity;
  readonly transparent?: boolean;
  readonly deformed?: boolean;
}

export interface OcclusionQueryResources {
  readonly pageIndex: number;
  readonly querySet: QuerySet;
  readonly resolveBuffer: Buffer;
  readonly stagingBuffer: Buffer;
}

export function createOcclusionQueryResources(
  device: RhiDevice,
  pageIndex: number,
): Result<OcclusionQueryResources, RhiError> {
  const querySet = device.createQuerySet({
    label: `occlusion-page-${pageIndex}`,
    type: 'occlusion',
    count: OCCLUSION_QUERY_PAGE_INDEX_LIMIT,
  });
  if (!querySet.ok) return querySet;
  const resolveBuffer = device.createBuffer({
    label: `occlusion-page-${pageIndex}-resolve`,
    size: OCCLUSION_QUERY_PAGE_BYTES,
    usage: GPU_BUFFER_USAGE_QUERY_RESOLVE | GPU_BUFFER_USAGE_COPY_SRC,
  });
  if (!resolveBuffer.ok) {
    device.destroyQuerySet(querySet.value);
    return resolveBuffer;
  }
  const stagingBuffer = device.createBuffer({
    label: `occlusion-page-${pageIndex}-staging`,
    size: OCCLUSION_QUERY_PAGE_BYTES,
    usage: GPU_BUFFER_USAGE_MAP_READ | GPU_BUFFER_USAGE_COPY_DST,
  });
  if (!stagingBuffer.ok) {
    device.destroyBuffer(resolveBuffer.value);
    device.destroyQuerySet(querySet.value);
    return stagingBuffer;
  }
  return ok({
    pageIndex,
    querySet: querySet.value,
    resolveBuffer: resolveBuffer.value,
    stagingBuffer: stagingBuffer.value,
  });
}

/** Records resolve and copy only; caller owns one shared encoder and submit. */
export function recordOcclusionResolve(
  encoder: RhiCommandEncoder,
  resources: OcclusionQueryResources,
  firstQuery: number,
  queryCount: number,
): Result<void, RhiError> {
  if (
    !Number.isSafeInteger(firstQuery) ||
    !Number.isSafeInteger(queryCount) ||
    firstQuery < 0 ||
    queryCount <= 0 ||
    firstQuery + queryCount > OCCLUSION_QUERY_PAGE_INDEX_LIMIT
  ) {
    return err(
      new RhiErrorClass({
        code: 'webgpu-runtime-error',
        expected: 'query range stays within one 4096-index page',
        hint: 'allocate a bounded page before recording occlusion resolve',
      }),
    );
  }
  const resolved = encoder.resolveQuerySet(
    resources.querySet,
    firstQuery,
    queryCount,
    resources.resolveBuffer,
    0,
  );
  if (!resolved.ok) return resolved;
  encoder.copyBufferToBuffer(resources.resolveBuffer, resources.stagingBuffer, queryCount * 8);
  return ok(undefined);
}

function finiteBounds(bounds: OcclusionBounds | undefined): bounds is OcclusionBounds {
  if (bounds === undefined) return false;
  return [...bounds.min, ...bounds.max].every((value) => Number.isFinite(value));
}

/** Creates only the transport plan; confidence remains owned by visibility facet/M4. */
export function buildOcclusionPassPlan(input: OcclusionPassInput): OcclusionPassPlan | undefined {
  if (
    input.transparent === true ||
    input.deformed === true ||
    !finiteBounds(input.bounds) ||
    !Number.isSafeInteger(input.queryIndex) ||
    input.queryIndex < 0
  ) {
    return undefined;
  }
  return Object.freeze({
    after: input.opaquePass,
    depth: { resource: input.depthResource, usage: 'depth-read-only' as const },
    color: { resource: input.colorResource, usage: 'not-written' as const },
    proxyBounds: input.bounds,
    queryIndex: input.queryIndex,
    ...(input.identity === undefined ? {} : { identity: Object.freeze({ ...input.identity }) }),
    resolve: { queryIndex: input.queryIndex, bytes: 8 },
    copy: { asynchronous: true as const, bytes: 8 },
    writesColor: false as const,
    writesDepth: false as const,
    submitCount: 1 as const,
    mapSameFrame: false as const,
  });
}

import type {
  Buffer,
  QuerySet,
  Result,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError as RhiErrorClass } from '@forgeax/engine-rhi';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_COPY_SRC,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_QUERY_RESOLVE,
} from '../../gpu-usage';
import {
  OCCLUSION_QUERY_PAGE_BYTES,
  OCCLUSION_QUERY_PAGE_INDEX_LIMIT,
} from './occlusion-query-pool';

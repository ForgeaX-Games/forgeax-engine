/// <reference types="@webgpu/types" />

import { computeTextureLayout } from './texel-layout';
import type { HandleId, RhiCallEvent } from './types';

/** A byte estimate that distinguishes known descriptor size from unavailable GPU facts. */
export type ResourceByteEstimate =
  | {
      readonly status: 'known';
      readonly bytes: number;
      readonly basis: 'buffer-descriptor' | 'texture-tight-layout';
    }
  | {
      readonly status: 'unavailable';
      readonly reason:
        | 'non-memory-resource'
        | 'unsupported-texture-dimension'
        | 'unsupported-texture-format'
        | 'invalid-texture-size';
    };

export type ResourceKind =
  | 'buffer'
  | 'texture'
  | 'texture-view'
  | 'sampler'
  | 'bind-group-layout'
  | 'bind-group'
  | 'pipeline-layout'
  | 'render-pipeline'
  | 'compute-pipeline'
  | 'shader-module';

export type ResourceOrigin = 'engine' | 'swapchain';

export interface ResourceLifecycleEntry {
  readonly handleId: HandleId;
  readonly kind: ResourceKind;
  readonly origin: ResourceOrigin;
  readonly state: 'live' | 'destroyed';
  readonly createdEventIndex: number;
  readonly destroyedEventIndex?: number;
  readonly byteEstimate: ResourceByteEstimate;
}

export interface ResourceLifecycleSummary {
  /** This is the resource closure represented by the tape, not the whole device heap. */
  readonly scope: 'captured-tape-resource-closure';
  readonly counts: {
    readonly created: number;
    readonly destroyed: number;
    readonly live: number;
    readonly destroyEvents: number;
    readonly unknownDestroyEvents: number;
  };
  readonly bytes: {
    readonly knownCreated: number;
    readonly knownDestroyed: number;
    readonly knownLive: number;
    readonly unavailableCreated: number;
    readonly unavailableDestroyed: number;
    readonly unavailableLive: number;
  };
  readonly originBreakdown: Readonly<
    Record<
      ResourceOrigin,
      {
        readonly created: number;
        readonly destroyed: number;
        readonly live: number;
        readonly knownCreated: number;
        readonly knownDestroyed: number;
        readonly knownLive: number;
        readonly unavailableCreated: number;
        readonly unavailableDestroyed: number;
        readonly unavailableLive: number;
      }
    >
  >;
  readonly availability: {
    readonly destroy: 'observed-buffer-texture';
    readonly retire: 'unavailable';
    readonly driverAllocation: 'unavailable';
  };
  readonly resources: readonly ResourceLifecycleEntry[];
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

function normalizeTextureSize(
  size: unknown,
):
  | { readonly width: number; readonly height: number; readonly depthOrArrayLayers: number }
  | undefined {
  if (typeof size === 'number') {
    const width = asPositiveInteger(size);
    return width === undefined ? undefined : { width, height: 1, depthOrArrayLayers: 1 };
  }
  if (Array.isArray(size)) {
    const width = asPositiveInteger(size[0]);
    const height = asPositiveInteger(size[1] ?? 1);
    const depthOrArrayLayers = asPositiveInteger(size[2] ?? 1);
    return width === undefined || height === undefined || depthOrArrayLayers === undefined
      ? undefined
      : { width, height, depthOrArrayLayers };
  }
  if (size !== null && typeof size === 'object') {
    const raw = size as {
      readonly width?: unknown;
      readonly height?: unknown;
      readonly depthOrArrayLayers?: unknown;
    };
    const width = asPositiveInteger(raw.width);
    const height = asPositiveInteger(raw.height ?? 1);
    const depthOrArrayLayers = asPositiveInteger(raw.depthOrArrayLayers ?? 1);
    return width === undefined || height === undefined || depthOrArrayLayers === undefined
      ? undefined
      : { width, height, depthOrArrayLayers };
  }
  return undefined;
}

function estimateBytes(event: RhiCallEvent): ResourceByteEstimate {
  if (event.kind === 'createBuffer') {
    return { status: 'known', bytes: event.desc.size, basis: 'buffer-descriptor' };
  }
  if (event.kind !== 'createTexture') {
    return { status: 'unavailable', reason: 'non-memory-resource' };
  }

  const dimension = event.desc.dimension ?? '2d';
  if (dimension === '3d') {
    return { status: 'unavailable', reason: 'unsupported-texture-dimension' };
  }
  const size = normalizeTextureSize(event.desc.size);
  if (size === undefined) return { status: 'unavailable', reason: 'invalid-texture-size' };
  const layers = dimension === '1d' ? 1 : size.depthOrArrayLayers;
  const layout = computeTextureLayout(
    event.desc.format,
    size.width,
    size.height,
    layers,
    event.desc.mipLevelCount ?? 1,
  );
  if (layout === undefined) return { status: 'unavailable', reason: 'unsupported-texture-format' };
  return {
    status: 'known',
    bytes: layout.totalBytes * (event.desc.sampleCount ?? 1),
    basis: 'texture-tight-layout',
  };
}

function resourceIdentity(
  event: RhiCallEvent,
): { readonly kind: ResourceKind; readonly handleId: HandleId } | undefined {
  switch (event.kind) {
    case 'createBuffer':
      return { kind: 'buffer', handleId: event.handleId };
    case 'createTexture':
      return { kind: 'texture', handleId: event.handleId };
    case 'createTextureView':
      return { kind: 'texture-view', handleId: event.resultHandleId };
    case 'createSampler':
      return { kind: 'sampler', handleId: event.handleId };
    case 'createBindGroupLayout':
      return { kind: 'bind-group-layout', handleId: event.handleId };
    case 'createBindGroup':
      return { kind: 'bind-group', handleId: event.handleId };
    case 'createPipelineLayout':
      return { kind: 'pipeline-layout', handleId: event.handleId };
    case 'createRenderPipeline':
      return { kind: 'render-pipeline', handleId: event.handleId };
    case 'createComputePipeline':
      return { kind: 'compute-pipeline', handleId: event.handleId };
    case 'createShaderModule':
      return { kind: 'shader-module', handleId: event.handleId };
    default:
      return undefined;
  }
}

function addBytes(
  bytes: { known: number; unavailable: number },
  estimate: ResourceByteEstimate,
): void {
  if (estimate.status === 'known') bytes.known += estimate.bytes;
  else bytes.unavailable++;
}

/** Build a pure lifecycle ledger from the ordered tape events. */
export function buildResourceLifecycle(events: readonly RhiCallEvent[]): ResourceLifecycleSummary {
  const records = new Map<
    HandleId,
    {
      readonly kind: ResourceKind;
      readonly origin: ResourceOrigin;
      readonly createdEventIndex: number;
      readonly byteEstimate: ResourceByteEstimate;
      destroyedEventIndex?: number;
    }
  >();
  const origins = new Map<HandleId, ResourceOrigin>();
  let destroyEvents = 0;
  let unknownDestroyEvents = 0;

  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    if (event === undefined) continue;
    const identity = resourceIdentity(event);
    if (identity !== undefined) {
      const origin: ResourceOrigin =
        event.kind === 'createTexture' && event.origin === 'swapchain'
          ? 'swapchain'
          : event.kind === 'createTextureView'
            ? (origins.get(event.sourceHandleId) ?? 'engine')
            : 'engine';
      origins.set(identity.handleId, origin);
      records.set(identity.handleId, {
        kind: identity.kind,
        origin,
        createdEventIndex: eventIndex,
        byteEstimate: estimateBytes(event),
      });
      continue;
    }
    if (event.kind !== 'destroyBuffer' && event.kind !== 'destroyTexture') continue;
    destroyEvents++;
    const record = records.get(event.handleId);
    const expectedKind = event.kind === 'destroyBuffer' ? 'buffer' : 'texture';
    if (
      record === undefined ||
      record.kind !== expectedKind ||
      record.destroyedEventIndex !== undefined
    ) {
      unknownDestroyEvents++;
      continue;
    }
    record.destroyedEventIndex = eventIndex;
  }

  const resources: ResourceLifecycleEntry[] = [];
  const createdBytes = { known: 0, unavailable: 0 };
  const destroyedBytes = { known: 0, unavailable: 0 };
  const liveBytes = { known: 0, unavailable: 0 };
  const originBreakdown: Record<
    ResourceOrigin,
    {
      created: number;
      destroyed: number;
      live: number;
      knownCreated: number;
      knownDestroyed: number;
      knownLive: number;
      unavailableCreated: number;
      unavailableDestroyed: number;
      unavailableLive: number;
    }
  > = {
    engine: {
      created: 0,
      destroyed: 0,
      live: 0,
      knownCreated: 0,
      knownDestroyed: 0,
      knownLive: 0,
      unavailableCreated: 0,
      unavailableDestroyed: 0,
      unavailableLive: 0,
    },
    swapchain: {
      created: 0,
      destroyed: 0,
      live: 0,
      knownCreated: 0,
      knownDestroyed: 0,
      knownLive: 0,
      unavailableCreated: 0,
      unavailableDestroyed: 0,
      unavailableLive: 0,
    },
  };
  let destroyed = 0;

  for (const [handleId, record] of records) {
    const state = record.destroyedEventIndex === undefined ? 'live' : 'destroyed';
    if (state === 'destroyed') destroyed++;
    addBytes(createdBytes, record.byteEstimate);
    addBytes(state === 'live' ? liveBytes : destroyedBytes, record.byteEstimate);
    const byOrigin = originBreakdown[record.origin];
    byOrigin.created++;
    if (state === 'destroyed') byOrigin.destroyed++;
    else byOrigin.live++;
    if (record.byteEstimate.status === 'known') {
      byOrigin.knownCreated += record.byteEstimate.bytes;
      if (state === 'destroyed') byOrigin.knownDestroyed += record.byteEstimate.bytes;
      else byOrigin.knownLive += record.byteEstimate.bytes;
    } else {
      byOrigin.unavailableCreated++;
      if (state === 'destroyed') byOrigin.unavailableDestroyed++;
      else byOrigin.unavailableLive++;
    }
    resources.push({
      handleId,
      kind: record.kind,
      origin: record.origin,
      state,
      createdEventIndex: record.createdEventIndex,
      ...(record.destroyedEventIndex === undefined
        ? {}
        : { destroyedEventIndex: record.destroyedEventIndex }),
      byteEstimate: record.byteEstimate,
    });
  }

  return {
    scope: 'captured-tape-resource-closure',
    counts: {
      created: resources.length,
      destroyed,
      live: resources.length - destroyed,
      destroyEvents,
      unknownDestroyEvents,
    },
    bytes: {
      knownCreated: createdBytes.known,
      knownDestroyed: destroyedBytes.known,
      knownLive: liveBytes.known,
      unavailableCreated: createdBytes.unavailable,
      unavailableDestroyed: destroyedBytes.unavailable,
      unavailableLive: liveBytes.unavailable,
    },
    originBreakdown,
    availability: {
      destroy: 'observed-buffer-texture',
      retire: 'unavailable',
      driverAllocation: 'unavailable',
    },
    resources,
  };
}

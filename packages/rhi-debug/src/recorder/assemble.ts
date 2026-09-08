import { err, ok, type Result } from '@forgeax/engine-types';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createRhiDebugError, type RhiDebugError } from '../errors';
import { encodeTape } from '../protocol/codec';
import type { BootstrapResource, Tape as V7Tape } from '../protocol/types';
import type { DebugRhiInstance } from '../recorder';
import type { HandleId, Tape as LegacyTape, RhiCallEvent } from '../types';

export interface EncodedTape {
  readonly bytes: Uint8Array;
  readonly digest: string;
  readonly tape: V7Tape;
}

export function assembleTape(recorder: DebugRhiInstance): Result<EncodedTape, RhiDebugError> {
  const legacy = recorder.getTape();
  if (legacy === undefined) {
    return err(
      createRhiDebugError('capture-snapshot-failed', {
        stage: 'snapshot',
        cause: 'the recorder finalized without a frame event',
      }),
    );
  }
  if ('code' in legacy) {
    return err(legacy);
  }
  const tape = toV7Tape(legacy, new Set(recorder.bootstrapEvents()));
  const encoded = encodeTape(tape);
  if (!encoded.ok) return err(encoded.error);
  return ok({
    bytes: encoded.value,
    digest: `sha256:${bytesToHex(sha256(encoded.value))}`,
    tape,
  });
}

function toV7Tape(legacy: LegacyTape, bootstrapEvents: ReadonlySet<RhiCallEvent>): V7Tape {
  const firstFrame = legacy.events.findIndex((event) => event.kind === 'frameMark');
  const boundary = firstFrame < 0 ? legacy.events.length : firstFrame;
  const bootstrap: BootstrapResource[] = [];
  const bootstrapIds = new Set<HandleId>();
  const initialData = new Map<HandleId, string[]>();
  for (const event of legacy.events.slice(0, boundary)) {
    if (event.kind === 'initialData') {
      const hashes = initialData.get(event.handleId) ?? [];
      hashes.push(event.dataHash);
      initialData.set(event.handleId, hashes);
      continue;
    }
    if (!bootstrapEvents.has(event)) continue;
    const handleId = createdHandleId(event);
    const kind = resourceKind(event);
    if (handleId === undefined || kind === undefined || bootstrapIds.has(handleId)) continue;
    bootstrapIds.add(handleId);
    bootstrap.push({
      handleId,
      kind,
      create: toJsonRecord(event),
      initialData: [],
    });
  }
  const allBlobs = Array.from(legacy.blobPool, ([hash, data]) => ({
    hash,
    bytes: new Uint8Array(data),
    compression: 'none' as const,
  }));
  const referenced = collectReferencedHandleIds(legacy.events, bootstrapEvents);
  const closure = collectBootstrapClosure(referenced, bootstrap);
  const keptBootstrap = bootstrap
    .filter((resource) => closure.has(resource.handleId))
    .map((resource) => {
      const hashes = initialData.get(resource.handleId) ?? [];
      const slices = hashes.flatMap((hash) => {
        const blob = legacy.blobPool.get(hash);
        return blob === undefined ? [] : [{ hash, byteOffset: 0, byteLength: blob.byteLength }];
      });
      return { ...resource, initialData: slices };
    });
  const events = legacy.events
    .filter((event) => event.kind !== 'initialData' && !bootstrapEvents.has(event))
    .map(toJsonSafe);
  const keptHashes = new Set(
    keptBootstrap.flatMap((resource) => resource.initialData.map((slice) => slice.hash)),
  );
  for (const event of events) {
    if ('dataHash' in event && typeof event.dataHash === 'string') keptHashes.add(event.dataHash);
  }
  const blobs = allBlobs.filter((blob) => keptHashes.has(blob.hash));
  return {
    header: {
      formatVersion: 7,
      rhiCaps: { ...legacy.rhiCapsRecorded },
      eventCount: events.length,
      blobCount: blobs.length,
    },
    bootstrap: keptBootstrap,
    events,
    blobs,
  };
}

function collectReferencedHandleIds(
  events: readonly RhiCallEvent[],
  bootstrapEvents: ReadonlySet<RhiCallEvent>,
): Set<HandleId> {
  const ids = new Set<HandleId>();
  for (const event of events) {
    if (event.kind === 'initialData' || bootstrapEvents.has(event)) continue;
    collectHandleStrings(event, ids);
  }
  return ids;
}

function collectHandleStrings(value: unknown, ids: Set<HandleId>): void {
  if (typeof value === 'string' && /^[a-zA-Z][a-zA-Z-]*:\S+$/.test(value)) {
    ids.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectHandleStrings(entry, ids);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) collectHandleStrings(entry, ids);
  }
}

function collectBootstrapClosure(
  referenced: ReadonlySet<HandleId>,
  resources: readonly BootstrapResource[],
): Set<HandleId> {
  const byId = new Map(resources.map((resource) => [resource.handleId, resource]));
  const closure = new Set<HandleId>();
  const pending = [...referenced];
  while (pending.length > 0) {
    const handleId = pending.pop();
    if (handleId === undefined || closure.has(handleId)) continue;
    const resource = byId.get(handleId);
    if (resource === undefined) continue;
    closure.add(handleId);
    const dependencies = new Set<HandleId>();
    collectHandleStrings(resource.create, dependencies);
    pending.push(...dependencies);
  }
  return closure;
}

function toJsonSafe(event: RhiCallEvent): RhiCallEvent {
  return JSON.parse(JSON.stringify(event)) as RhiCallEvent;
}

function toJsonRecord(event: RhiCallEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event));
}

function createdHandleId(event: RhiCallEvent): HandleId | undefined {
  if (event.kind === 'createTextureView') return event.resultHandleId;
  if (event.kind === 'createCommandEncoder') return event.cmdHandleId;
  if (event.kind === 'beginRenderPass' || event.kind === 'beginComputePass') {
    return event.passHandleId;
  }
  if (event.kind.startsWith('create') && 'handleId' in event) return event.handleId;
  return undefined;
}

function resourceKind(event: RhiCallEvent): BootstrapResource['kind'] | undefined {
  switch (event.kind) {
    case 'createBuffer':
      return 'buffer';
    case 'createTexture':
      return 'texture';
    case 'createTextureView':
      return 'texture-view';
    case 'createSampler':
      return 'sampler';
    case 'createShaderModule':
      return 'shader-module';
    case 'createRenderPipeline':
    case 'createComputePipeline':
      return 'pipeline';
    case 'createBindGroup':
    case 'createBindGroupLayout':
    case 'createPipelineLayout':
      return 'binding';
    case 'createCommandEncoder':
      return 'encoder';
    default:
      return undefined;
  }
}

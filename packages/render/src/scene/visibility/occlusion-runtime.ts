import type {
  Buffer,
  QuerySet,
  RenderPipeline,
  Result,
  RhiCommandEncoder,
  RhiDevice,
  RhiError,
  RhiRenderPassEncoder,
} from '@forgeax/engine-rhi';
import { err, ok, RhiError as RhiErrorClass } from '@forgeax/engine-rhi';
import {
  GPU_BUFFER_USAGE_COPY_DST,
  GPU_BUFFER_USAGE_MAP_READ,
  GPU_BUFFER_USAGE_VERTEX,
} from '../../gpu-usage';
import type { PipelineBuilderShaderModuleFactory } from '../../pipeline-builder';
import type { VisibilityBudget } from './budget';
import type { VisibilityFacetStore } from './facet';
import {
  createOcclusionQueryResources,
  type OcclusionBounds,
  type OcclusionQueryResources,
  recordOcclusionResolve,
} from './occlusion-pass';
import {
  OCCLUSION_QUERY_PAGE_INDEX_LIMIT,
  OcclusionQueryPool,
  type OcclusionQueryReservation,
  type OcclusionQueryTicket,
} from './occlusion-query-pool';
import {
  type PrimitiveKey,
  primitiveKeyId,
  type ViewKey,
  type VisibilityCandidate,
  viewKeyId,
} from './types';

const PROXY_VERTEX_FLOATS_PER_CANDIDATE = 36 * 4;
const PROXY_GEOMETRY_BYTES =
  OCCLUSION_QUERY_PAGE_INDEX_LIMIT * PROXY_VERTEX_FLOATS_PER_CANDIDATE * 4;

/** @internal Deterministic producer hook; never configured by the player API. */
export interface OcclusionRuntimeTestHooks {
  readonly beforeMap?: () => Promise<void>;
}

let runtimeTestHooks: OcclusionRuntimeTestHooks | undefined;

/** @internal Used only by the production evidence falsification harness. */
export function setOcclusionRuntimeTestHooks(hooks: OcclusionRuntimeTestHooks | undefined): void {
  runtimeTestHooks = hooks;
}

export interface OcclusionRuntimeCandidate {
  readonly view: ViewKey;
  readonly primitive: PrimitiveKey;
  readonly epoch: number;
  readonly bounds: OcclusionBounds;
  readonly candidate: VisibilityCandidate;
  readonly deviceGeneration: number;
  /** Clip-space triangles for the conservative bounds proxy. */
  readonly proxyVertices?: Float32Array;
}

export interface OcclusionFrameProjection {
  readonly querySet: QuerySet | undefined;
  readonly queryIndex: number;
  readonly queryCount: number;
  readonly sampleCount: 1 | 4;
  readonly pageIndex: number;
  readonly reservationId: number;
  readonly encodeProxyBounds: (pass: RhiRenderPassEncoder) => Result<void, RhiError>;
  readonly beginCandidate: (pass: RhiRenderPassEncoder) => Result<void, RhiError>;
  readonly endCandidate: (pass: RhiRenderPassEncoder) => Result<void, RhiError>;
  readonly recordResolve: (encoder: RhiCommandEncoder) => Result<void, RhiError>;
  readonly commit: (
    submitted: boolean,
    submissionGeneration: number,
    profilePhase?: OcclusionProfilePhaseRunner,
  ) => void;
}

export type OcclusionProfilePhaseRunner = <T>(
  phase: 'record/occlusion-query-submit' | 'record/occlusion-global-advance',
  action: () => T,
) => T;

interface PendingFrame {
  readonly reservations: readonly OcclusionQueryReservation[];
  readonly resources: OcclusionQueryResources;
  readonly candidates: readonly OcclusionRuntimeCandidate[];
  readonly sampleCount: 1 | 4;
  endedCount: number;
  readonly proxyFloatCount: number;
}

/**
 * RenderSystem-owned query transport. It is deliberately the only bridge
 * between the logical pool, the typed graph raster pass, and facet completion.
 */
export class OcclusionRenderRuntime {
  private readonly pool = new OcclusionQueryPool();
  private readonly resources = new Map<number, OcclusionQueryResources>();
  private readonly activeCompletions = new Map<OcclusionQueryResources, Promise<void>>();
  private readonly retiredResources = new Set<OcclusionQueryResources>();
  /** Candidate descriptors are rebuilt only when the extracted frame changes. */
  private candidateSource: readonly OcclusionRuntimeCandidate[] | undefined;
  private validCandidates: readonly OcclusionRuntimeCandidate[] = [];
  private readonly candidateByKey = new Map<string, OcclusionRuntimeCandidate>();
  private lastPrepareUnavailable = false;
  private pendingFrame: PendingFrame | undefined;
  private sampleCount: 1 | 4 = 1;
  private disposed = false;
  private proxyBuffer: Buffer | undefined;
  private readonly proxyScratch: Float32Array;
  private proxyPipeline: RenderPipeline | undefined;
  private proxyPipelineSampleCount: 1 | 4 | undefined;
  private readonly queryLatencySamplesUs: number[] = [];
  private lastQueryLatencyUs = 0;
  private readonly projection: OcclusionFrameProjection;

  constructor(
    private readonly device: RhiDevice,
    private readonly facets: VisibilityFacetStore,
    private readonly shaderModuleFactory?: PipelineBuilderShaderModuleFactory,
    private readonly budget: VisibilityBudget = facets.visibilityBudget(),
  ) {
    const runtime = this;
    this.proxyScratch = new Float32Array(
      Math.min(this.budget.effectiveQueryBudget, OCCLUSION_QUERY_PAGE_INDEX_LIMIT) *
        PROXY_VERTEX_FLOATS_PER_CANDIDATE,
    );
    this.projection = {
      get querySet() {
        return runtime.pendingFrame?.resources.querySet;
      },
      get queryIndex() {
        return runtime.pendingFrame?.reservations[0]?.queryIndex ?? 0;
      },
      get queryCount() {
        return runtime.pendingFrame?.reservations.length ?? 0;
      },
      get sampleCount() {
        return runtime.sampleCount;
      },
      get pageIndex() {
        return runtime.pendingFrame?.reservations[0]?.pageIndex ?? 0;
      },
      get reservationId() {
        return runtime.pendingFrame?.reservations[0]?.reservationId ?? 0;
      },
      encodeProxyBounds: (pass) => {
        const pending = runtime.pendingFrame;
        return pending === undefined ? ok(undefined) : runtime.encodeProxyBounds(pass, pending);
      },
      beginCandidate: (pass) => {
        const pending = runtime.pendingFrame;
        if (pending === undefined || pending.endedCount >= pending.reservations.length) {
          return err(runtimeError('the current RenderSystem frame owns the occlusion candidate'));
        }
        return pass.beginOcclusionQuery(pending.reservations[pending.endedCount]?.queryIndex ?? 0);
      },
      endCandidate: (pass) => {
        const pending = runtime.pendingFrame;
        if (pending === undefined || pending.endedCount >= pending.reservations.length) {
          return err(runtimeError('the current RenderSystem frame owns the occlusion candidate'));
        }
        const ended = pass.endOcclusionQuery();
        if (ended.ok) pending.endedCount += 1;
        return ended;
      },
      recordResolve: (encoder) => {
        const pending = runtime.pendingFrame;
        if (pending === undefined) return ok(undefined);
        if (pending.endedCount !== pending.reservations.length) {
          return err(runtimeError('the real geometry pass must end its occlusion query first'));
        }
        return recordOcclusionResolve(
          encoder,
          pending.resources,
          pending.reservations[0]?.queryIndex ?? 0,
          pending.reservations.length,
        );
      },
      commit: (submitted, submissionGeneration, profilePhase) => {
        const pending = runtime.pendingFrame;
        if (pending !== undefined) {
          runtime.commit(pending, submitted, submissionGeneration, profilePhase);
        } else if (submitted) {
          // Idle queries still consume a successful frame of hidden-row
          // confidence. Otherwise suppressed rows would never become due again.
          const advance = () => runtime.advanceSuccessfulSubmit(submissionGeneration);
          if (profilePhase === undefined) advance();
          else profilePhase('record/occlusion-global-advance', advance);
        }
      },
    };
  }

  prepare(candidate: OcclusionRuntimeCandidate): OcclusionFrameProjection | undefined {
    // Keep the single-candidate helper useful for transport unit tests and
    // direct callers. The RenderSystem uses prepareBatch's facet-owned queue.
    return this.prepareBatch([candidate], 1, false);
  }

  prepareBatch(
    candidates: readonly OcclusionRuntimeCandidate[],
    sampleCount: 1 | 4 = 1,
    useReadyQueue = true,
  ): OcclusionFrameProjection | undefined {
    this.lastPrepareUnavailable = false;
    if (this.disposed || candidates.length === 0) return undefined;
    if (this.pendingFrame !== undefined) {
      this.lastPrepareUnavailable = true;
      return undefined;
    }
    this.sampleCount = sampleCount;
    if (this.candidateSource !== candidates) {
      this.candidateSource = candidates;
      this.candidateByKey.clear();
      const valid: OcclusionRuntimeCandidate[] = [];
      for (const candidate of candidates) {
        this.candidateByKey.set(candidateKey(candidate.view, candidate.primitive), candidate);
        if (finiteBounds(candidate.bounds)) valid.push(candidate);
      }
      this.validCandidates = valid;
    }
    const valid = this.validCandidates;
    if (valid.length === 0) return undefined;

    let selectedCandidates: OcclusionRuntimeCandidate[];
    if (!useReadyQueue) {
      selectedCandidates = valid.slice(0, this.budget.effectiveQueryBudget);
    } else {
      const firstView = valid[0]?.view;
      if (firstView === undefined) return undefined;
      selectedCandidates = [];
      for (const entry of this.facets.dequeueQueryCandidates(
        firstView,
        this.budget.effectiveQueryBudget,
      )) {
        const candidate = this.candidateByKey.get(candidateKey(entry.view, entry.primitive));
        if (candidate === undefined || !finiteBounds(candidate.bounds)) {
          this.facets.requeueQueryCandidate(entry.view, entry.primitive);
          continue;
        }
        selectedCandidates.push(candidate);
      }
      // No ready work is a normal bounded-query frame, not a transport error.
      // An empty ready queue is frame-local work state. Preserve the projection
      // so the graph and its cached shadow atlas survive idle query frames.
      if (selectedCandidates.length === 0) return this.projection;
    }

    const reservations: OcclusionQueryReservation[] = [];
    let selectedCount = 0;
    while (selectedCount < selectedCandidates.length) {
      const candidate = selectedCandidates[selectedCount];
      if (candidate === undefined) break;
      const reservation = this.pool.reserve({
        viewKey: viewKeyId(candidate.view),
        attachmentId: candidate.view.attachmentId,
        deviceGeneration: candidate.deviceGeneration,
        worldGeneration: candidate.primitive.worldGeneration,
        primitiveSlot: candidate.primitive.primitiveSlot,
        slotGeneration: candidate.primitive.slotGeneration,
      });
      if (reservation === undefined) {
        this.lastPrepareUnavailable = true;
        break;
      }
      if (reservations.length > 0 && reservation.pageIndex !== reservations[0]?.pageIndex) {
        this.pool.cancel(reservation);
        this.lastPrepareUnavailable = true;
        break;
      }
      reservations.push(reservation);
      selectedCount += 1;
      if (reservations.length >= this.budget.effectiveQueryBudget) break;
    }
    if (reservations.length === 0) {
      for (const candidate of selectedCandidates) {
        if (useReadyQueue) this.facets.requeueQueryCandidate(candidate.view, candidate.primitive);
      }
      return undefined;
    }
    if (reservations.length < selectedCandidates.length) {
      for (const reservation of reservations) this.pool.cancel(reservation);
      for (const candidate of selectedCandidates) {
        if (useReadyQueue) this.facets.requeueQueryCandidate(candidate.view, candidate.primitive);
      }
      return undefined;
    }
    const resources = this.ensureResources(reservations[0]?.pageIndex ?? 0);
    if (resources === undefined) {
      for (const reservation of reservations) this.pool.cancel(reservation);
      this.lastPrepareUnavailable = true;
      for (const candidate of selectedCandidates) {
        if (useReadyQueue) this.facets.requeueQueryCandidate(candidate.view, candidate.primitive);
      }
      return undefined;
    }
    const selected = selectedCandidates;
    let proxyFloatCount = 0;
    for (const candidate of selected) {
      const vertices = candidate.proxyVertices;
      if (vertices === undefined) continue;
      if (proxyFloatCount + vertices.length > this.proxyScratch.length) {
        for (const reservation of reservations) this.pool.cancel(reservation);
        for (const queuedCandidate of selectedCandidates) {
          if (useReadyQueue) {
            this.facets.requeueQueryCandidate(queuedCandidate.view, queuedCandidate.primitive);
          }
        }
        this.lastPrepareUnavailable = true;
        return undefined;
      }
      this.proxyScratch.set(vertices, proxyFloatCount);
      proxyFloatCount += vertices.length;
    }
    const pending: PendingFrame = {
      reservations,
      resources,
      candidates: selected,
      sampleCount,
      endedCount: 0,
      proxyFloatCount,
    };
    this.pendingFrame = pending;
    return this.projection;
  }

  inspect(): ReturnType<OcclusionQueryPool['inspect']> {
    return this.pool.inspect();
  }

  get prepareUnavailable(): boolean {
    return this.lastPrepareUnavailable;
  }

  /** Map-only latency from the submitted query page; queue wait is excluded. */
  inspectQueryLatency(): { readonly median: number; readonly p95: number; readonly last: number } {
    if (this.queryLatencySamplesUs.length === 0) {
      return { median: 0, p95: 0, last: this.lastQueryLatencyUs };
    }
    const sorted = [...this.queryLatencySamplesUs].sort((left, right) => left - right);
    const rank = (percentile: number): number =>
      sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)] ?? 0;
    return {
      median: rank(0.5),
      p95: rank(0.95),
      last: this.lastQueryLatencyUs,
    };
  }

  /**
   * Wait until query readbacks submitted before the current observation have
   * settled. The renderer receipt only fences command submission; query
   * completion also includes the asynchronous map/unmap transition. Keeping
   * that fence here makes `renderer.observe()` publish the latest visibility
   * result and measured map latency instead of racing the readback promise.
   */
  async waitForCompletions(): Promise<void> {
    // A submission callback can publish the next page while the previous
    // completion is settling. Drain until the map stays empty so observation
    // cannot return with a newer query still racing the inspection update.
    for (;;) {
      const completions = [...this.activeCompletions.values()];
      if (completions.length === 0) return;
      await Promise.all(completions);
    }
  }

  /** Count a successful frame for hidden rows that were not queried this frame. */
  advanceSuccessfulSubmit(submissionGeneration: number): void {
    this.facets.advanceSuccessfulSubmits(submissionGeneration);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pool.dispose();
    for (const resource of this.resources.values()) {
      const completion = this.activeCompletions.get(resource);
      if (completion === undefined) {
        this.destroyResources(resource);
      } else {
        // A completion may still be awaiting mapAsync. Destroying its staging
        // buffer here makes Dawn report a use-after-destroy validation error.
        void completion.then(() => this.destroyResources(resource));
      }
    }
    this.resources.clear();
    if (this.proxyBuffer !== undefined) this.device.destroyBuffer(this.proxyBuffer);
    this.proxyBuffer = undefined;
    this.proxyPipeline = undefined;
    this.proxyPipelineSampleCount = undefined;
    this.candidateSource = undefined;
    this.validCandidates = [];
    this.candidateByKey.clear();
    this.lastPrepareUnavailable = false;
    this.pendingFrame = undefined;
  }

  private ensureResources(pageIndex: number): OcclusionQueryResources | undefined {
    const existing = this.resources.get(pageIndex);
    if (existing !== undefined) return existing;
    const created = createOcclusionQueryResources(this.device, pageIndex);
    if (!created.ok) return undefined;
    this.resources.set(pageIndex, created.value);
    return created.value;
  }

  private commit(
    pending: PendingFrame,
    submitted: boolean,
    submissionGeneration: number,
    profilePhase?: OcclusionProfilePhaseRunner,
  ): void {
    if (this.pendingFrame !== pending) return;
    this.pendingFrame = undefined;
    const tickets: OcclusionQueryTicket[] = [];
    const accepted =
      profilePhase === undefined
        ? this.publishAndApplySubmit(pending, submitted, submissionGeneration, tickets)
        : profilePhase('record/occlusion-query-submit', () =>
            this.publishAndApplySubmit(pending, submitted, submissionGeneration, tickets),
          );
    if (!accepted) {
      for (const reservation of pending.reservations) this.pool.cancel(reservation);
      for (const candidate of pending.candidates) {
        this.facets.applyConfidence(candidate.view, candidate.primitive, {
          type: 'failure',
          submissionGeneration,
        });
      }
      return;
    }

    if (profilePhase === undefined) {
      this.facets.advanceSuccessfulSubmits(submissionGeneration);
    } else {
      profilePhase('record/occlusion-global-advance', () =>
        this.facets.advanceSuccessfulSubmits(submissionGeneration),
      );
    }
    const completion = this.completeAfterSubmit(tickets, pending);
    this.activeCompletions.set(pending.resources, completion);
    void completion.then(() => {
      if (this.activeCompletions.get(pending.resources) === completion) {
        this.activeCompletions.delete(pending.resources);
      }
    });
  }

  private publishAndApplySubmit(
    pending: PendingFrame,
    submitted: boolean,
    submissionGeneration: number,
    tickets: OcclusionQueryTicket[],
  ): boolean {
    for (const reservation of pending.reservations) {
      const ticket = this.pool.publish(reservation, { submitted, submissionGeneration });
      if (ticket !== undefined) tickets.push(ticket);
    }
    if (!submitted || tickets.length !== pending.reservations.length) return false;
    const submitEvent = Object.freeze({ type: 'submit' as const, submissionGeneration });
    for (const candidate of pending.candidates) {
      this.facets.applyConfidence(candidate.view, candidate.primitive, submitEvent);
    }
    return true;
  }

  private destroyResources(resource: OcclusionQueryResources): void {
    if (this.retiredResources.has(resource)) return;
    this.retiredResources.add(resource);
    this.device.destroyBuffer(resource.resolveBuffer);
    this.device.destroyBuffer(resource.stagingBuffer);
    this.device.destroyQuerySet(resource.querySet);
  }

  private async completeAfterSubmit(
    tickets: readonly OcclusionQueryTicket[],
    pending: PendingFrame,
  ): Promise<void> {
    try {
      await this.device.queue.onSubmittedWorkDone();
      const mapStart = performance.now();
      await runtimeTestHooks?.beforeMap?.();
      const mapped = await pending.resources.stagingBuffer.mapAsync(
        GPU_BUFFER_USAGE_MAP_READ,
        0,
        pending.reservations.length * 8,
      );
      if (!mapped.ok) throw mapped.error;
      // Inspection is a bounded integer POD; keep the real map-only duration
      // while rounding sub-microsecond timer noise at the transport boundary.
      this.lastQueryLatencyUs = Math.max(0, Math.round((performance.now() - mapStart) * 1000));
      this.queryLatencySamplesUs.push(this.lastQueryLatencyUs);
      if (this.queryLatencySamplesUs.length > 64) this.queryLatencySamplesUs.shift();
      const bytes = mapped.value.getMappedRange(0, pending.reservations.length * 8);
      if (!bytes.ok) throw bytes.error;
      // WebGPU detaches the mapped range when unmap() is called. Copy the
      // bounded query payload while it is still mapped, then release the
      // staging buffer before applying any facet mutations. Reading the view
      // after unmap would throw on real Dawn and turn every result into the
      // fail-open failure path (leaving candidates permanently visible).
      const data = new Uint8Array(bytes.value.slice(0));
      const dataView = new DataView(data.buffer);
      const firstQuery = pending.reservations[0]?.queryIndex ?? 0;
      mapped.value.unmap();
      for (let ticketIndex = tickets.length - 1; ticketIndex >= 0; ticketIndex -= 1) {
        const ticket = tickets[ticketIndex];
        if (ticket === undefined) continue;
        const candidateIndex = ticket.queryIndex - firstQuery;
        const samples = dataView.getUint32(candidateIndex * 8, true);
        const completion = this.pool.complete(ticket, samples);
        if (completion.status !== 'accepted') continue;
        const candidate = pending.candidates[candidateIndex];
        if (candidate === undefined) continue;
        this.facets.applyConfidence(candidate.view, candidate.primitive, {
          type: 'result',
          samples,
          submissionGeneration: ticket.submissionGeneration,
        });
        this.facets.applyCompletion(
          candidate.view,
          candidate.primitive,
          candidate.epoch,
          candidate.candidate,
        );
      }
    } catch {
      for (const ticket of tickets) {
        this.pool.complete(ticket, Number.NaN);
        const candidate =
          pending.candidates[ticket.queryIndex - (pending.reservations[0]?.queryIndex ?? 0)];
        if (candidate !== undefined) {
          this.facets.applyConfidence(candidate.view, candidate.primitive, {
            type: 'failure',
            submissionGeneration: ticket.submissionGeneration,
          });
        }
      }
    }
  }

  private encodeProxyBounds(
    pass: RhiRenderPassEncoder,
    pending: PendingFrame,
  ): Result<void, RhiError> {
    if (pending.proxyFloatCount === 0) {
      return err(runtimeError('every occlusion candidate needs conservative proxy geometry'));
    }
    const pipeline = this.ensureProxyPipeline(pending.sampleCount);
    if (pipeline === undefined) {
      // RhiNull has no shader-module factory. It still records the complete
      // query fan-out structurally so lifecycle and identity tests exercise
      // the same bounded transport; real backends take the mesh path below.
      for (const reservation of pending.reservations) {
        const began = pass.beginOcclusionQuery(reservation.queryIndex);
        if (!began.ok) return began;
        const ended = pass.endOcclusionQuery();
        if (!ended.ok) return ended;
      }
      pending.endedCount = pending.reservations.length;
      return ok(undefined);
    }
    const buffer = this.ensureProxyBuffer(pending.proxyFloatCount * Float32Array.BYTES_PER_ELEMENT);
    if (buffer === undefined) {
      return err(runtimeError('the backend must allocate the bounded proxy geometry buffer'));
    }
    const uploaded = this.device.queue.writeBuffer(
      buffer,
      0,
      this.proxyScratch.subarray(0, pending.proxyFloatCount),
    );
    if (!uploaded.ok) return uploaded;
    pass.setPipeline(pipeline);
    pass.setVertexBuffer(0, buffer);
    let vertexOffset = 0;
    for (let index = 0; index < pending.reservations.length; index += 1) {
      const vertices = pending.candidates[index]?.proxyVertices;
      if (vertices === undefined || vertices.length === 0) continue;
      const began = pass.beginOcclusionQuery(pending.reservations[index]?.queryIndex ?? 0);
      if (!began.ok) return began;
      pass.draw(vertices.length / 4, 1, vertexOffset / 4, 0);
      const ended = pass.endOcclusionQuery();
      if (!ended.ok) return ended;
      vertexOffset += vertices.length;
    }
    pending.endedCount = pending.reservations.length;
    return ok(undefined);
  }

  private ensureProxyBuffer(byteLength: number): Buffer | undefined {
    if (this.proxyBuffer !== undefined) return this.proxyBuffer;
    const created = this.device.createBuffer({
      label: 'occlusion-bounds-proxy-geometry',
      size: Math.max(16, PROXY_GEOMETRY_BYTES, byteLength),
      usage: GPU_BUFFER_USAGE_VERTEX | GPU_BUFFER_USAGE_COPY_DST,
    });
    if (!created.ok) return undefined;
    this.proxyBuffer = created.value;
    return created.value;
  }

  private ensureProxyPipeline(sampleCount: 1 | 4): RenderPipeline | undefined {
    if (this.proxyPipelineSampleCount === sampleCount && this.proxyPipeline !== undefined) {
      return this.proxyPipeline;
    }
    if (this.shaderModuleFactory === undefined) return undefined;
    const module = this.shaderModuleFactory.createShaderModule({
      label: 'occlusion-bounds-proxy',
      code: PROXY_BOUNDS_WGSL,
    });
    if (!module.ok) return undefined;
    const created = this.device.createRenderPipeline({
      label: 'occlusion-bounds-proxy',
      layout: 'auto',
      vertex: {
        module: module.value,
        entryPoint: 'vs_main',
        buffers: [
          {
            arrayStride: 16,
            stepMode: 'vertex',
            attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x4' }],
          },
        ],
      },
      // The proxy is recorded in the typed main pass, whose color attachment
      // remains RGBA16Float. Keep the pass compatible while suppressing all
      // color writes; occlusion only consumes depth samples.
      fragment: {
        module: module.value,
        entryPoint: 'fs_main',
        targets: [{ format: 'rgba16float', writeMask: 0 }],
      },
      primitive: { topology: 'triangle-list' },
      depthStencil: {
        format: 'depth32float-stencil8',
        depthWriteEnabled: false,
        depthCompare: 'greater-equal',
      },
      multisample: { count: sampleCount },
    });
    if (!created.ok) return undefined;
    this.proxyPipeline = created.value;
    this.proxyPipelineSampleCount = sampleCount;
    return created.value;
  }
}

const PROXY_BOUNDS_WGSL = `
@vertex
fn vs_main(@location(0) position: vec4f) -> @builtin(position) vec4f {
  return position;
}
@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(0.0);
}
`;

function candidateKey(view: ViewKey, primitive: PrimitiveKey): string {
  return `${viewKeyId(view)}|${primitiveKeyId(primitive)}`;
}

function finiteBounds(bounds: OcclusionBounds): boolean {
  return [...bounds.min, ...bounds.max].every((value) => Number.isFinite(value));
}

function runtimeError(hint: string): RhiError {
  return new RhiErrorClass({
    code: 'webgpu-runtime-error',
    expected: 'RenderSystem owns one active occlusion candidate for the shared frame',
    hint,
  });
}

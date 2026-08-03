// @forgeax/engine-rhi-debug/src/inspect-core — node-free per-draw inspect (L3b).
//
// Atom functions: extractDrawInfo, findPassIdx, mapResourceKindToInspectKind,
// DrawInfo type — moved verbatim from inspector.ts (F-1 self-contained closure).
//
// Composite function: inspectDrawJson — cropping orchestration single SSOT (D-1),
// returns Promise<Result<InspectReport, DebugError>>. Node inspectAt (M2) derives
// from this; browser callers (L3b) use it directly.
//
// Related: requirements AC-01/AC-02/AC-05; plan-strategy D-1/D-3/D-4.

/// <reference types="@webgpu/types" />

import type { RhiDevice } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { DebugError } from './errors';
import { readbackDrawRt } from './readback';
import { computePassOffsets, DRAW_KINDS } from './tape-format';
import type {
  CreateDescriptor,
  DrawPipelineState,
  HandleId,
  InspectBindingEntry,
  InspectDrawCall,
  InspectFields,
  InspectReport,
  InspectRtPixels,
  RhiCallEvent,
} from './types';

// ============================================================================
// DrawInfo — result shape of extractDrawInfo
// ============================================================================

/**
 * Result of extractDrawInfo — information about a draw at a given index.
 */
export interface DrawInfo {
  readonly frameIdx: number;
  readonly passIdx: number;
  readonly bindings: readonly InspectBindingEntry[];
  readonly drawCall: InspectDrawCall;
  readonly colorAttachmentHandleId: string | undefined;
  /** Prefer the single-sample MSAA resolve target for pixel readback. */
  readonly colorAttachmentResolveTargetHandleId: string | undefined;
}

type BindGroupDefinition = {
  readonly entries: readonly {
    readonly binding: number;
    readonly resourceKind: 'sampler' | 'buffer' | 'textureView' | 'externalTexture';
  }[];
  readonly resourceHandleIds: readonly string[];
};

/**
 * Scan a tape once and project every draw event to its inspect shape.
 *
 * `extractDrawInfo` historically repeated this scan for every draw. That is
 * acceptable for one interactive inspect, but makes the whole-frame summary
 * quadratic on real editor frames (thousands of draws). Keep the scan state
 * here as the SSOT and let both the single-draw and whole-frame consumers use
 * it.
 */
export function extractDrawInfos(events: readonly RhiCallEvent[]): readonly DrawInfo[] {
  let frameIdx = 0;
  const bindGroups = new Map<number, InspectBindingEntry[]>();
  const bindGroupDefs = new Map<string, BindGroupDefinition>();
  let lastColorAttachmentHandleId: string | undefined;
  let lastColorAttachmentResolveTargetHandleId: string | undefined;
  const lastSeenPerPass = new Map<
    string,
    { pipelineKind: 'render' | 'compute'; pipelineHandleId: string }
  >();
  let currentPassHandleId: string | undefined;
  const infos: DrawInfo[] = [];

  for (const event of events) {
    if (event.kind === 'frameMark') {
      frameIdx = event.frameIdx;
    }

    if (event.kind === 'beginRenderPass') {
      currentPassHandleId = event.passHandleId;
      lastColorAttachmentHandleId = event.colorAttachmentViewHandleIds[0] ?? undefined;
      lastColorAttachmentResolveTargetHandleId =
        event.colorAttachmentResolveTargetHandleIds?.[0] ?? undefined;
    } else if (event.kind === 'beginComputePass') {
      currentPassHandleId = event.passHandleId;
      lastColorAttachmentHandleId = undefined;
      lastColorAttachmentResolveTargetHandleId = undefined;
    } else if (event.kind === 'endRenderPass' || event.kind === 'endComputePass') {
      currentPassHandleId = undefined;
    }

    if (event.kind === 'setPipeline' && currentPassHandleId !== undefined) {
      lastSeenPerPass.set(currentPassHandleId, {
        pipelineKind: 'render',
        pipelineHandleId: event.pipelineHandleId,
      });
    } else if (event.kind === 'setComputePipeline' && currentPassHandleId !== undefined) {
      lastSeenPerPass.set(currentPassHandleId, {
        pipelineKind: 'compute',
        pipelineHandleId: event.pipelineHandleId,
      });
    }

    if (event.kind === 'createBindGroup') {
      bindGroupDefs.set(event.handleId, {
        entries: event.entries,
        resourceHandleIds: event.resourceHandleIds,
      });
    }

    if (event.kind === 'setBindGroup') {
      const def = bindGroupDefs.get(event.bindGroupHandleId);
      if (def !== undefined) {
        bindGroups.set(
          event.index,
          def.entries.map((entry, idx) => ({
            groupIndex: event.index,
            entryIndex: entry.binding,
            handleId: def.resourceHandleIds[idx] ?? event.bindGroupHandleId,
            kind: mapResourceKindToInspectKind(entry.resourceKind),
          })),
        );
      } else {
        bindGroups.set(event.index, [
          {
            groupIndex: event.index,
            entryIndex: 0,
            handleId: event.bindGroupHandleId,
            kind: 'buffer',
          },
        ]);
      }
    }

    if (!DRAW_KINDS.has(event.kind)) continue;

    const pipelineInfo =
      currentPassHandleId !== undefined ? lastSeenPerPass.get(currentPassHandleId) : undefined;
    const pipelineKind =
      pipelineInfo?.pipelineKind ?? (event.kind === 'dispatchWorkgroups' ? 'compute' : 'render');
    const pipelineHandleId = pipelineInfo?.pipelineHandleId ?? 'unknown';
    let drawCall: InspectDrawCall;
    if (event.kind === 'draw') {
      drawCall = {
        pipelineKind,
        pipelineHandleId,
        vertexCount: event.vertexCount,
        instanceCount: event.instanceCount,
        firstVertex: event.firstVertex,
        firstInstance: event.firstInstance,
      };
    } else if (event.kind === 'drawIndexed') {
      drawCall = {
        pipelineKind,
        pipelineHandleId,
        indexCount: event.indexCount,
        instanceCount: event.instanceCount,
        firstIndex: event.firstIndex,
        baseVertex: event.baseVertex,
        firstInstance: event.firstInstance,
      };
    } else if (event.kind === 'drawIndirect' || event.kind === 'drawIndexedIndirect') {
      drawCall = {
        pipelineKind,
        pipelineHandleId,
        indirectBufferHandleId: event.indirectBufferHandleId,
        indirectOffset: event.indirectOffset,
      };
    } else if (event.kind === 'dispatchWorkgroups') {
      drawCall = {
        pipelineKind,
        pipelineHandleId,
        dispatchX: event.x,
        dispatchY: event.y,
        dispatchZ: event.z,
      };
    } else {
      // DRAW_KINDS is closed; keep a defensive shape if the set and event
      // union ever drift during an incremental change.
      drawCall = { pipelineKind, pipelineHandleId };
    }

    const bindings: InspectBindingEntry[] = [];
    for (const entries of bindGroups.values()) bindings.push(...entries);
    infos.push({
      frameIdx,
      passIdx: -1,
      bindings,
      drawCall,
      colorAttachmentHandleId: lastColorAttachmentHandleId,
      colorAttachmentResolveTargetHandleId: lastColorAttachmentResolveTargetHandleId,
    });
  }

  return infos;
}

// ============================================================================
// mapResourceKindToInspectKind
// ============================================================================

/**
 * Project the recorder-side `RhiBindResourceKind` (closed 4 union, mirrors
 * the RHI BindResource kind discriminant) onto the inspector-facing
 * `InspectBindingEntry.kind` set ('buffer' | 'texture' | 'sampler' |
 * 'textureView'). cubemap / 2D / 3D / array textures all flow through
 * `textureView` — the recorder cannot distinguish dimension at this
 * boundary, so AI users discriminate texture dimension via the
 * `createTextureView`/`createTexture` event chain rather than this enum.
 */
export function mapResourceKindToInspectKind(
  k: 'sampler' | 'buffer' | 'textureView' | 'externalTexture',
): 'buffer' | 'texture' | 'sampler' | 'textureView' {
  switch (k) {
    case 'sampler':
      return 'sampler';
    case 'buffer':
      return 'buffer';
    case 'textureView':
      return 'textureView';
    case 'externalTexture':
      return 'texture';
  }
}

// ============================================================================
// Resource + pipeline-state atoms (shared by frame-model + inspectDrawJson)
// ============================================================================

/** Pipe an Iterable through an array so we can .map() it. */
function iterToArray<T>(it: Iterable<T>): T[] {
  const out: T[] = [];
  for (const v of it) out.push(v);
  return out;
}

/** Build the resources map (handleId -> descriptor) from all create* events. */
export function buildResources(
  events: readonly RhiCallEvent[],
): ReadonlyMap<HandleId, CreateDescriptor> {
  const map = new Map<HandleId, CreateDescriptor>();

  for (const event of events) {
    switch (event.kind) {
      case 'createBuffer':
        map.set(event.handleId, {
          kind: 'createBuffer',
          handleId: event.handleId,
          size: event.desc.size,
          usage: event.desc.usage,
        });
        break;
      case 'createTexture':
        map.set(event.handleId, {
          kind: 'createTexture',
          handleId: event.handleId,
          format: event.desc.format,
          size: [1, 1, 1] as const,
          mipLevelCount: event.desc.mipLevelCount ?? 1,
          sampleCount: event.desc.sampleCount ?? 1,
          dimension: event.desc.dimension ?? '2d',
          usage: event.desc.usage,
        });
        break;
      case 'createSampler':
        map.set(event.handleId, {
          kind: 'createSampler',
          handleId: event.handleId,
          desc: event.desc ?? undefined,
        });
        break;
      case 'createBindGroupLayout':
        map.set(event.handleId, {
          kind: 'createBindGroupLayout',
          handleId: event.handleId,
          entries: iterToArray(event.desc.entries),
        });
        break;
      case 'createPipelineLayout':
        map.set(event.handleId, {
          kind: 'createPipelineLayout',
          handleId: event.handleId,
          bglHandleIds: event.bglHandleIds,
        });
        break;
      case 'createRenderPipeline':
        map.set(event.handleId, {
          kind: 'createRenderPipeline',
          handleId: event.handleId,
          vertex: event.desc.vertex,
          primitive: event.desc.primitive,
          depthStencil: event.desc.depthStencil,
          multisample: event.desc.multisample,
          fragment: event.desc.fragment,
          layoutHandleId: event.layoutHandleId,
          vertexShaderModuleHandleId: event.vertexShaderModuleHandleId,
          fragmentShaderModuleHandleId: event.fragmentShaderModuleHandleId,
        });
        break;
      case 'createShaderModule':
        map.set(event.handleId, {
          kind: 'createShaderModule',
          handleId: event.handleId,
          wgslCode: event.wgslCode,
        });
        break;
    }
  }

  return map;
}

/**
 * Per-pass state accumulated from a tape scan: the bound pipeline + dynamic
 * state (vertex buffers, blend constant, stencil reference) and the pass's
 * depth-stencil attachment. Indexed by passIdx in scanPassStates' return.
 */
export interface PassState {
  handleId: HandleId;
  pipelineHandleId: HandleId | undefined;
  /**
   * Bound vertex buffers keyed by slot. Each entry carries the raw
   * `setVertexBuffer` triple (`handleId`, `offset`, `size`) verbatim: offset
   * defaults to 0 when the event omits it; size 0 preserves the WebGPU spec
   * intent ("bind from offset to end of buffer") — we do not normalise.
   */
  vertexBuffers: Map<number, { handleId: HandleId; offset: number; size: number }>;
  /** Bound index buffer for the pass (mirrors `setIndexBuffer` event). Undefined until set. */
  indexBuffer: { handleId: HandleId; format: GPUIndexFormat; offset: number } | undefined;
  blendConstant: GPUColor | undefined;
  stencilReference: number;
  depthStencilViewHandleId: HandleId | undefined;
  depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined;
}

/** Pre-scan events to build per-pass state, indexed by passIdx. */
export function scanPassStates(events: readonly RhiCallEvent[]): PassState[] {
  const states: PassState[] = [];
  let current: PassState | null = null;

  for (const event of events) {
    if (event.kind === 'beginRenderPass') {
      current = {
        handleId: event.passHandleId,
        pipelineHandleId: undefined,
        vertexBuffers: new Map(),
        indexBuffer: undefined,
        blendConstant: undefined,
        stencilReference: 0,
        depthStencilViewHandleId: event.depthStencilViewHandleId,
        depthStencilAttachment: event.desc.depthStencilAttachment,
      };
      states.push(current);
    } else if (event.kind === 'beginComputePass') {
      current = {
        handleId: event.passHandleId,
        pipelineHandleId: undefined,
        vertexBuffers: new Map(),
        indexBuffer: undefined,
        blendConstant: undefined,
        stencilReference: 0,
        depthStencilViewHandleId: undefined,
        depthStencilAttachment: undefined,
      };
      states.push(current);
    } else if (current !== null && event.kind === 'setPipeline') {
      current.pipelineHandleId = event.pipelineHandleId;
    } else if (current !== null && event.kind === 'setVertexBuffer') {
      current.vertexBuffers.set(event.slot, {
        handleId: event.bufferHandleId,
        offset: event.offset ?? 0,
        size: event.size ?? 0,
      });
    } else if (current !== null && event.kind === 'setIndexBuffer') {
      current.indexBuffer = {
        handleId: event.bufferHandleId,
        format: event.format,
        offset: event.offset ?? 0,
      };
    } else if (current !== null && event.kind === 'setBlendConstant') {
      current.blendConstant = event.color;
    } else if (current !== null && event.kind === 'setStencilReference') {
      current.stencilReference = event.reference;
    }
  }

  return states;
}

const DEFAULT_STENCIL = {
  compare: 'always' as GPUCompareFunction,
  failOp: 'keep' as GPUStencilOperation,
  depthFailOp: 'keep' as GPUStencilOperation,
  passOp: 'keep' as GPUStencilOperation,
} as const;

/** Compute per-draw pipelineState from the resource map + the draw's pass state. */
export function makePipelineState(
  pipelineHandleId: HandleId | undefined,
  resources: ReadonlyMap<HandleId, CreateDescriptor>,
  passState: PassState,
): DrawPipelineState {
  const desc = pipelineHandleId ? resources.get(pipelineHandleId) : undefined;
  const rpDesc = desc?.kind === 'createRenderPipeline' ? desc : undefined;

  const vertexBufs = Array.from(rpDesc?.vertex?.buffers ?? []).filter(
    (b): b is GPUVertexBufferLayout => b !== null && b !== undefined,
  );
  const fragTargets = Array.from(rpDesc?.fragment?.targets ?? []).filter(
    (t): t is GPUColorTargetState => t !== null && t !== undefined,
  );

  return {
    inputAssembly: {
      topology: rpDesc?.primitive?.topology ?? 'triangle-list',
      stripIndexFormat: rpDesc?.primitive?.stripIndexFormat,
    },
    vertexInput: {
      buffers: vertexBufs.map((b) => {
        const attrs = Array.from(b.attributes ?? []).map((a) => ({
          format: a.format,
          offset: a.offset,
          shaderLocation: a.shaderLocation,
        }));
        return {
          arrayStride: b.arrayStride,
          stepMode: (b.stepMode ?? 'vertex') as GPUVertexStepMode,
          attributes: attrs,
        };
      }),
    },
    shaders: {
      vertexShaderModuleHandleId: rpDesc?.vertexShaderModuleHandleId,
      fragmentShaderModuleHandleId: rpDesc?.fragmentShaderModuleHandleId,
      vertexEntryPoint: rpDesc?.vertex?.entryPoint,
      fragmentEntryPoint: rpDesc?.fragment?.entryPoint,
    },
    rasterizer: {
      cullMode: rpDesc?.primitive?.cullMode ?? 'none',
      frontFace: rpDesc?.primitive?.frontFace ?? 'ccw',
    },
    depthStencil: {
      format: rpDesc?.depthStencil?.format ?? 'depth24plus',
      depthWriteEnabled: rpDesc?.depthStencil?.depthWriteEnabled ?? false,
      depthCompare: rpDesc?.depthStencil?.depthCompare ?? 'always',
      stencilFront: rpDesc?.depthStencil?.stencilFront ?? DEFAULT_STENCIL,
      stencilBack: rpDesc?.depthStencil?.stencilBack ?? DEFAULT_STENCIL,
      stencilReadMask: rpDesc?.depthStencil?.stencilReadMask ?? 0xffffffff,
      stencilWriteMask: rpDesc?.depthStencil?.stencilWriteMask ?? 0xffffffff,
      depthBias: rpDesc?.depthStencil?.depthBias ?? 0,
      depthBiasSlopeScale: rpDesc?.depthStencil?.depthBiasSlopeScale ?? 0,
      depthBiasClamp: rpDesc?.depthStencil?.depthBiasClamp ?? 0,
      stencilReference: passState.stencilReference,
    },
    blend: {
      colorTargets: fragTargets.map((t) => ({
        format: t.format,
        color: t.blend?.color,
        alpha: t.blend?.alpha,
        writeMask: t.writeMask ?? 0xf,
      })),
      blendConstant: passState.blendConstant,
    },
    multisample: {
      count: rpDesc?.multisample?.count ?? 1,
      mask: rpDesc?.multisample?.mask ?? 0xffffffff,
      alphaToCoverageEnabled: rpDesc?.multisample?.alphaToCoverageEnabled ?? false,
    },
  };
}

// ============================================================================
// extractDrawInfo
// ============================================================================

/**
 * Extract draw information from tape events up to a given draw index.
 *
 * Walks events from start, tracking frameMark boundaries, bind group state,
 * and the current render pass setup to produce the InspectReport fields.
 */
export function extractDrawInfo(events: readonly RhiCallEvent[], targetDrawIdx: number): DrawInfo {
  const info = extractDrawInfos(events)[targetDrawIdx];
  if (info !== undefined) return info;

  let frameIdx = 0;
  for (const event of events) {
    if (event.kind === 'frameMark') frameIdx = event.frameIdx;
  }
  return {
    frameIdx,
    passIdx: -1,
    bindings: [],
    drawCall: {
      pipelineKind: 'render',
      pipelineHandleId: 'unknown',
    },
    colorAttachmentHandleId: undefined,
    colorAttachmentResolveTargetHandleId: undefined,
  };
}

// ============================================================================
// findPassIdx
// ============================================================================

/**
 * Find the pass index for a given draw index.
 *
 * Uses computePassOffsets to find which pass contains the draw.
 */
export function findPassIdx(events: readonly RhiCallEvent[], drawIdx: number): number {
  const offsets = computePassOffsets(events);
  for (const offset of offsets) {
    if (drawIdx >= offset.startDrawIdx && drawIdx <= offset.endDrawIdx) {
      return offset.passIdx;
    }
  }
  return -1;
}

// ============================================================================
// inspectDrawJson — composite cropping orchestration (D-1 single SSOT)
// ============================================================================

/**
 * Count the total number of draw/dispatch events in the events array.
 */
function countDraws(events: readonly RhiCallEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (DRAW_KINDS.has(event.kind)) {
      count++;
    }
  }
  return count;
}

/**
 * Map a global drawIdx (the Nth draw/dispatch call in the tape) to its event
 * index. `Replay.stepTo` / `commitThroughDraw` take an event index, not a draw
 * index, so callers walk the events linearly counting draw / drawIndexed /
 * dispatchWorkgroups occurrences. Returns -1 when the tape has fewer draws than
 * requested. SSOT for the draw->event mapping: replayer.ts and cli.ts both
 * import this rather than keeping private copies.
 */
export function findEventIdxForDraw(events: readonly RhiCallEvent[], drawIdx: number): number {
  let count = 0;
  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (ev === undefined) continue;
    if (DRAW_KINDS.has(ev.kind)) {
      if (count === drawIdx) return i;
      count++;
    }
  }
  return -1;
}

/**
 * Inspect a specific drawIdx within a replay session and return a structured
 * JSON report.
 *
 * Receives an **already-built** Replay (not a tape) — per D-1, Node
 * `inspectAt` and browser callers both pass an existing replay, so
 * `inspectDrawJson` does NOT call `createReplay`.
 *
 * Stepping is the CALLER's responsibility and decides what the `rt` field shows:
 * for cumulative-after-N pixels (the per-draw RT inspect contract) the caller
 * must `replay.commitThroughDraw(drawIdx)` first; for the whole composited frame
 * the caller uses `replay.stepTo(events.length - 1)`. `readbackDrawRt` here only
 * reads the target attachment's current GPU state — it does not step.
 *
 * @param replay - The already-constructed Replay session.
 * @param drawIdx - The global draw event index to inspect (0-based).
 * @param events - The tape events array for extracting frame/pass info
 *   and validating drawIdx bounds.
 * @param device - The RhiDevice for optional RT readback.
 * @param fields - Which fields to include in the report.
 *   - `['bindings']`: only bind group info, no RT readback.
 *   - `['drawCall']`: only draw call metadata.
 *   - `['rt']`: triggers RT readback via `readbackDrawRt`.
 *   - `undefined`: full report with all fields including RT.
 *   - `[]`: minimum report (frameIdx/drawIdx/passIdx only).
 * @returns InspectReport with the requested fields populated, or a DebugError
 *   if drawIdx is out of range.
 */
export async function inspectDrawJson(
  replay: import('./replayer').Replay,
  drawIdx: number,
  events: readonly RhiCallEvent[],
  device: RhiDevice,
  fields?: readonly InspectFields[],
): Promise<Result<InspectReport, DebugError>> {
  // DrawIdx bounds validation
  const totalDraws = countDraws(events);
  if (drawIdx < 0 || drawIdx >= totalDraws) {
    return err(
      new DebugError({
        code: 'replay-step-out-of-range',
        expected: `drawIdx to be in range [0, ${totalDraws - 1}]`,
        hint: `drawIdx ${drawIdx} is out of range for a tape with ${totalDraws} draw/dispatch events`,
        detail: {
          requestedStep: drawIdx,
          currentStep: 0,
          totalEvents: totalDraws,
        },
      }),
    );
  }

  // Compute draw info from events up to drawIdx
  const drawInfo = extractDrawInfo(events, drawIdx);

  // Get passIdx for this draw
  const passIdx = findPassIdx(events, drawIdx);

  // Determine which fields to include
  const fieldSet = fields !== undefined ? new Set(fields) : undefined;
  const wantBindings = fieldSet === undefined || fieldSet.has('bindings');
  const wantDrawCall = fieldSet === undefined || fieldSet.has('drawCall');
  const wantRt = fieldSet === undefined || fieldSet.has('rt');

  // Read back RT if requested. The browser path hands back the structured
  // InspectRtPixels triple (the Node CLI re-encodes it to a PNG path; see
  // InspectRtPayload). No `as any` needed — InspectReport.rt accepts this shape.
  let rtPayload: InspectRtPixels | undefined;
  if (wantRt) {
    const rtResult = await readbackDrawRt(replay, drawIdx, device);
    if (!rtResult.ok) {
      return err(rtResult.error);
    }
    rtPayload = rtResult.value;
  }

  // Build the report by cropping: each unrequested field stays genuinely
  // absent (AC-12), not assigned undefined. frameIdx/drawIdx/passIdx are the
  // only required InspectReport members and are always set here; bindings/
  // drawCall/rt are optional, so `result` already satisfies InspectReport with
  // no cast — the type now reflects the cropping honestly (no type-lie).
  const result: Mutable<InspectReport> = {
    frameIdx: drawInfo.frameIdx,
    drawIdx,
    passIdx,
  };
  if (wantBindings) {
    result.bindings = drawInfo.bindings;
  }
  if (wantDrawCall) {
    result.drawCall = drawInfo.drawCall;
  }
  if (rtPayload !== undefined) {
    result.rt = rtPayload;
  }

  // pipelineState is always attached (not gated by `fields`) so an AI
  // inspect-offline call sees the same seven pipeline stages the viewer's
  // PipelineState panel renders — same SSOT atoms buildFrameModel uses.
  const passStates = scanPassStates(events);
  const passState = passStates[passIdx];
  if (passState !== undefined) {
    const resources = buildResources(events);
    result.pipelineState = makePipelineState(passState.pipelineHandleId, resources, passState);
  }

  return ok(result);
}

/** Strip `readonly` so the cropped report can be built field by field. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

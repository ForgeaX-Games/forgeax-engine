// viewer-model.ts — buildViewModel: budget-phase ViewModel computation (zero React, zero GPU).
//
// Pure function of Tape -> ViewModel. Two-stage design:
//   1. Budget phase (this module): computePassOffsets + extractDrawInfo -> full tree + draws.
//      All bindings/drawCall data is stored; no GPU interaction.
//   2. Lazy phase (M4 RtPanel): renderRtToCanvas fills RT pixels on draw selection.
//
// Zero-copy per D-4: window.__forgeaxViewer = vm exposes the same object reference,
// not a field-by-field copy. AC-14 enforcement point: page.evaluate must return
// the same structural identity.
//
// AC-02: tree pass/draw counts MUST equal computePassOffsets direct computation --
// buildViewModel uses computePassOffsets, never a separate hand-written counter.
//
// M4 extension: commands (full command stream), resources (handleId -> CreateDescriptor),
// draws[].pipelineState (7 stages), draws[].vertexBuffers, draws[].depthStencil.
// All from pure event analysis (zero GPU per Finding 8).
//
// Related: plan-strategy D-4 (zero-copy), D-5 (pure function), D-9 (natural empty state);
//   AC-02/AC-03/AC-04/AC-05/AC-11/AC-14/AC-17/AC-19/AC-28.

/// <reference types="@webgpu/types" />

import type {
  HandleId,
  InspectBindingEntry,
  InspectDrawCall,
  PassOffset,
  RhiCallEvent,
  Tape,
} from '@forgeax/engine-rhi-debug';
import { computePassOffsets } from '@forgeax/engine-rhi-debug';
import { extractDrawInfo, findPassIdx } from '@forgeax/engine-rhi-debug/inspect-core';

// ============================================================================
// ViewModel types
// ============================================================================

/** A single draw/dispatch sub-item within a pass node. */
export interface PassDrawItem {
  readonly drawIdx: number;
  readonly eventKind:
    | 'draw'
    | 'drawIndexed'
    | 'dispatchWorkgroups'
    | 'drawIndirect'
    | 'drawIndexedIndirect';
}

/** A pass node in the tree -- render or compute pass. */
export interface PassNode {
  readonly kind: 'render' | 'compute';
  readonly passIdx: number;
  readonly draws: readonly PassDrawItem[];
}

/** Full information for a single draw/dispatch call. */
export interface DrawEntry {
  readonly frameIdx: number;
  readonly passIdx: number;
  readonly bindings: readonly InspectBindingEntry[];
  readonly drawCall: InspectDrawCall;
  readonly colorAttachmentHandleId: string | undefined;
  // -- M4 extension: pipeline state from pure event analysis --
  readonly pipelineState: DrawPipelineState;
  readonly vertexBuffers: ReadonlyMap<number, HandleId>;
  readonly depthStencil: DrawDepthStencil;
}

/** Pipeline state for a single draw call, extracted from createRenderPipeline + runtime events. */
export interface DrawPipelineState {
  readonly inputAssembly: {
    readonly topology: GPUPrimitiveTopology;
    readonly stripIndexFormat: GPUIndexFormat | undefined;
  };
  readonly vertexInput: {
    readonly buffers: readonly {
      readonly arrayStride: number;
      readonly stepMode: GPUVertexStepMode;
      readonly attributes: readonly {
        readonly format: GPUVertexFormat;
        readonly offset: number;
        readonly shaderLocation: number;
      }[];
    }[];
  };
  readonly shaders: {
    readonly vertexShaderModuleHandleId: HandleId | undefined;
    readonly fragmentShaderModuleHandleId: HandleId | undefined;
  };
  readonly rasterizer: {
    readonly cullMode: GPUCullMode;
    readonly frontFace: GPUFrontFace;
  };
  readonly depthStencil: {
    readonly format: GPUTextureFormat;
    readonly depthWriteEnabled: boolean;
    readonly depthCompare: GPUCompareFunction;
    readonly stencilFront: NonNullable<GPUDepthStencilState['stencilFront']>;
    readonly stencilBack: NonNullable<GPUDepthStencilState['stencilBack']>;
    readonly stencilReadMask: number;
    readonly stencilWriteMask: number;
    readonly depthBias: number;
    readonly depthBiasSlopeScale: number;
    readonly depthBiasClamp: number;
    readonly stencilReference: number;
  };
  readonly blend: {
    readonly colorTargets: readonly {
      readonly format: GPUTextureFormat;
      readonly color: GPUBlendComponent | undefined;
      readonly alpha: GPUBlendComponent | undefined;
      readonly writeMask: GPUColorWriteFlags;
    }[];
    readonly blendConstant: GPUColor | undefined;
  };
  readonly multisample: {
    readonly count: number;
    readonly mask: number;
    readonly alphaToCoverageEnabled: boolean;
  };
}

/** Depth-stencil attachment reference for a draw call. */
export interface DrawDepthStencil {
  readonly depthStencilViewHandleId: HandleId | undefined;
  readonly depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined;
}

/** A command entry in the full command stream (includes non-draw events). */
export interface CommandEntry {
  readonly passIdx: number;
  readonly eventIdx: number;
  readonly isDraw: boolean;
  readonly kind: string;
  /** Group label for pushDebugGroup/passPushDebugGroup events (for collapsible nesting). */
  readonly groupLabel: string | undefined;
  /** Marker label for insertDebugMarker/passInsertDebugMarker events. */
  readonly markerLabel: string | undefined;
}

/**
 * A resource descriptor parsed from a create* event.
 * Discriminated by kind for consumption by ResourceInspector panel.
 */
export type CreateDescriptor =
  | {
      readonly kind: 'createBuffer';
      readonly handleId: HandleId;
      readonly size: GPUSize64;
      readonly usage: GPUBufferUsageFlags;
    }
  | {
      readonly kind: 'createTexture';
      readonly handleId: HandleId;
      readonly format: GPUTextureFormat;
      readonly size: readonly number[];
      readonly mipLevelCount: number;
      readonly sampleCount: number;
      readonly dimension: GPUTextureDimension;
      readonly usage: GPUTextureUsageFlags;
    }
  | {
      readonly kind: 'createSampler';
      readonly handleId: HandleId;
      readonly desc: Partial<GPUSamplerDescriptor> | undefined;
    }
  | {
      readonly kind: 'createBindGroupLayout';
      readonly handleId: HandleId;
      readonly entries: readonly GPUBindGroupLayoutEntry[];
    }
  | {
      readonly kind: 'createPipelineLayout';
      readonly handleId: HandleId;
      readonly bglHandleIds: readonly HandleId[];
    }
  | {
      readonly kind: 'createRenderPipeline';
      readonly handleId: HandleId;
      readonly vertex: GPUVertexState | undefined;
      readonly primitive: GPUPrimitiveState | undefined;
      readonly depthStencil: GPUDepthStencilState | undefined;
      readonly multisample: GPUMultisampleState | undefined;
      readonly fragment: GPUFragmentState | undefined;
      readonly layoutHandleId: HandleId;
      readonly vertexShaderModuleHandleId: HandleId | undefined;
      readonly fragmentShaderModuleHandleId: HandleId | undefined;
    }
  | { readonly kind: 'createShaderModule'; readonly handleId: HandleId; readonly wgslCode: string };

/** Summary metadata about the tape. */
export interface ViewModelMeta {
  readonly totalDraws: number;
  readonly totalPasses: number;
  readonly hasCompute: boolean;
}

/** The complete ViewModel, exposed as window.__forgeaxViewer. */
export interface ViewModel {
  readonly tree: readonly PassNode[];
  readonly draws: readonly DrawEntry[];
  readonly meta: ViewModelMeta;
  /** M4: full command stream in tape order (includes non-draw events). */
  readonly commands: readonly CommandEntry[];
  /** M4: handleId to parsed create descriptor. */
  readonly resources: ReadonlyMap<HandleId, CreateDescriptor>;
}

// ============================================================================
// Event-kind extraction
// ============================================================================

function eventKindAt(
  events: readonly RhiCallEvent[],
  globalDrawIdx: number,
): PassDrawItem['eventKind'] {
  let idx = 0;
  for (const event of events) {
    if (
      event.kind === 'draw' ||
      event.kind === 'drawIndexed' ||
      event.kind === 'drawIndirect' ||
      event.kind === 'drawIndexedIndirect' ||
      event.kind === 'dispatchWorkgroups'
    ) {
      if (idx === globalDrawIdx) {
        return event.kind;
      }
      idx++;
    }
  }
  return 'draw'; // unreachable for valid globalDrawIdx; defensive fallback
}

/** Count total draw/dispatch events. */
function countDrawEvents(events: readonly RhiCallEvent[]): number {
  let count = 0;
  for (const event of events) {
    if (
      event.kind === 'draw' ||
      event.kind === 'drawIndexed' ||
      event.kind === 'drawIndirect' ||
      event.kind === 'drawIndexedIndirect' ||
      event.kind === 'dispatchWorkgroups'
    ) {
      count++;
    }
  }
  return count;
}

// ============================================================================
// M4 helpers: commands, resources, per-draw state
// ============================================================================

const DRAW_KINDS = new Set([
  'draw',
  'drawIndexed',
  'drawIndirect',
  'drawIndexedIndirect',
  'dispatchWorkgroups',
]);

const META_KINDS = new Set(['frameMark', 'submit', 'finish', 'createCommandEncoder']);

/** Pipe an Iterable through an array so we can .map() it. */
function iterToArray<T>(it: Iterable<T>): T[] {
  const out: T[] = [];
  for (const v of it) out.push(v);
  return out;
}

/** Build the full command stream (all events in tape order, minus meta events). */
function buildCommands(events: readonly RhiCallEvent[]): readonly CommandEntry[] {
  const commands: CommandEntry[] = [];
  let currentPassIdx = -1;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event) continue;

    // Track pass boundaries
    if (event.kind === 'beginRenderPass' || event.kind === 'beginComputePass') {
      currentPassIdx++;
    }

    // Skip meta events
    if (META_KINDS.has(event.kind)) continue;

    // Extract debug group / marker labels
    let groupLabel: string | undefined;
    let markerLabel: string | undefined;
    if (event.kind === 'pushDebugGroup' || event.kind === 'passPushDebugGroup') {
      groupLabel = event.groupLabel;
    } else if (event.kind === 'insertDebugMarker' || event.kind === 'passInsertDebugMarker') {
      markerLabel = event.markerLabel;
    }

    commands.push({
      passIdx: currentPassIdx,
      eventIdx: i,
      isDraw: DRAW_KINDS.has(event.kind),
      kind: event.kind,
      groupLabel,
      markerLabel,
    });
  }

  return commands;
}

/** Build the resources map from all create* events. */
function buildResources(events: readonly RhiCallEvent[]): ReadonlyMap<string, CreateDescriptor> {
  const map = new Map<string, CreateDescriptor>();

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
 * Pre-scan events to build per-pass state maps.
 * Returns a structure indexed by passIdx with fields needed for DrawEntry construction.
 */
interface PassState {
  handleId: HandleId;
  pipelineHandleId: HandleId | undefined;
  vertexBuffers: Map<number, HandleId>;
  blendConstant: GPUColor | undefined;
  stencilReference: number;
  depthStencilViewHandleId: HandleId | undefined;
  depthStencilAttachment: GPURenderPassDepthStencilAttachment | undefined;
}

function scanPassStates(events: readonly RhiCallEvent[]): PassState[] {
  const states: PassState[] = [];
  let current: PassState | null = null;

  for (const event of events) {
    if (event.kind === 'beginRenderPass') {
      current = {
        handleId: event.passHandleId,
        pipelineHandleId: undefined,
        vertexBuffers: new Map(),
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
        blendConstant: undefined,
        stencilReference: 0,
        depthStencilViewHandleId: undefined,
        depthStencilAttachment: undefined,
      };
      states.push(current);
    } else if (current !== null && event.kind === 'setPipeline') {
      current.pipelineHandleId = event.pipelineHandleId;
    } else if (current !== null && event.kind === 'setVertexBuffer') {
      current.vertexBuffers.set(event.slot, event.bufferHandleId);
    } else if (current !== null && event.kind === 'setBlendConstant') {
      current.blendConstant = event.color;
    } else if (current !== null && event.kind === 'setStencilReference') {
      current.stencilReference = event.reference;
    }
  }

  return states;
}

/** Compute per-draw pipelineState from resource map + pass state. */
function makePipelineState(
  pipelineHandleId: HandleId | undefined,
  resources: ReadonlyMap<string, CreateDescriptor>,
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
  const defaultStencil = {
    compare: 'always' as GPUCompareFunction,
    failOp: 'keep' as GPUStencilOperation,
    depthFailOp: 'keep' as GPUStencilOperation,
    passOp: 'keep' as GPUStencilOperation,
  } as const;

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
    },
    rasterizer: {
      cullMode: rpDesc?.primitive?.cullMode ?? 'none',
      frontFace: rpDesc?.primitive?.frontFace ?? 'ccw',
    },
    depthStencil: {
      format: rpDesc?.depthStencil?.format ?? 'depth24plus',
      depthWriteEnabled: rpDesc?.depthStencil?.depthWriteEnabled ?? false,
      depthCompare: rpDesc?.depthStencil?.depthCompare ?? 'always',
      stencilFront: rpDesc?.depthStencil?.stencilFront ?? defaultStencil,
      stencilBack: rpDesc?.depthStencil?.stencilBack ?? defaultStencil,
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
// buildViewModel
// ============================================================================

/**
 * Compute ViewModel from a Tape.
 *
 * Budget phase (no GPU): produces full tree structure and per-draw
 * bindings/drawCall from pure events analysis using the existing
 * computePassOffsets, extractDrawInfo, and findPassIdx primitives.
 *
 * M4 extension: additionally computes commands (full command stream),
 * resources (handleId -> create descriptors), and per-draw pipelineState /
 * vertexBuffers / depthStencil from pure event traversal.
 *
 * @param tape - The deserialized tape to analyse.
 * @returns ViewModel with tree, draws, meta, commands, and resources.
 */
export function buildViewModel(tape: Tape): ViewModel {
  const events = tape.events;

  // Step 1: build pass offsets
  const offsets = computePassOffsets(events);

  // Step 2: build tree from offsets
  const tree: PassNode[] = offsets.map((offset: PassOffset) => {
    const draws: PassDrawItem[] = [];
    for (let di = offset.startDrawIdx; di <= offset.endDrawIdx; di++) {
      draws.push({
        drawIdx: di,
        eventKind: eventKindAt(events, di),
      });
    }
    return {
      kind: offset.kind,
      passIdx: offset.passIdx,
      draws,
    };
  });

  // Step 3: M4 pre-scan — resources + pass states
  const resources = buildResources(events);
  const passStates = scanPassStates(events);

  // Step 4: build per-draw entries
  const totalDraws = countDrawEvents(events);
  const draws: DrawEntry[] = [];
  let hasCompute = false;

  for (let i = 0; i < totalDraws; i++) {
    const info = extractDrawInfo(events, i);
    const passIdx = findPassIdx(events, i);

    // Resolve pass state for this draw
    const passState = passStates[passIdx];
    const pipelineState = makePipelineState(
      passState?.pipelineHandleId,
      resources,
      passState ?? {
        handleId: '',
        pipelineHandleId: undefined,
        vertexBuffers: new Map(),
        blendConstant: undefined,
        stencilReference: 0,
        depthStencilViewHandleId: undefined,
        depthStencilAttachment: undefined,
      },
    );
    const vertexBuffers: ReadonlyMap<number, HandleId> = passState?.vertexBuffers ?? new Map();
    const depthStencil: DrawDepthStencil = {
      depthStencilViewHandleId: passState?.depthStencilViewHandleId,
      depthStencilAttachment: passState?.depthStencilAttachment,
    };

    draws.push({
      frameIdx: info.frameIdx,
      passIdx,
      bindings: info.bindings,
      drawCall: info.drawCall,
      colorAttachmentHandleId: info.colorAttachmentHandleId,
      pipelineState,
      vertexBuffers,
      depthStencil,
    });

    if (info.drawCall.pipelineKind === 'compute') {
      hasCompute = true;
    }
  }

  // Step 5: build commands
  const commands = buildCommands(events);

  return {
    tree,
    draws,
    meta: {
      totalDraws,
      totalPasses: offsets.length,
      hasCompute,
    },
    commands,
    resources,
  };
}

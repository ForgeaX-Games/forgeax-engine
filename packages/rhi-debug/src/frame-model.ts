// frame-model.ts — buildFrameModel: pure whole-frame analysis (zero React, zero GPU, node-free).
//
// SSOT for "what a tape contains, structurally": pass/draw tree, per-draw pipeline state,
// bindings, draw call, resources, and the full command stream. Both consumers share it:
//   - apps/rhi-debug-viewer re-exports FrameModel/buildFrameModel as its ViewModel (UI panels).
//   - packages/rhi-debug/src/cli.ts `summary` subcommand emits buildFrameModel(tape) as JSON.
// inspect-core.ts attaches the same per-draw pipelineState to InspectReport via the shared
// scanPassStates + makePipelineState atoms it owns. One analysis, two surfaces (charter F1:
// the AI inspects with the same operations the UI exposes).
//
// Layering (no import cycle): frame-model -> inspect-core (atoms) -> types (shapes).
// Browser-safe: imports only node-free atoms; no node:/pngjs/inspector imports.
// tree-shake.unit.test.ts locks this in.

/// <reference types="@webgpu/types" />

import {
  buildResources,
  extractDrawInfo,
  findPassIdx,
  makePipelineState,
  scanPassStates,
} from './inspect-core';
import type { PassOffset } from './tape-format';
import { computePassOffsets, DRAW_KINDS } from './tape-format';
import type {
  CreateDescriptor,
  DrawPipelineState,
  HandleId,
  InspectBindingEntry,
  InspectDrawCall,
  RhiCallEvent,
  Tape,
} from './types';

// Re-export the shared pipeline/resource shapes so consumers that import them
// "from the frame model" (the viewer's ../viewer-model shim) resolve here too.
export type { CreateDescriptor, DrawPipelineState } from './types';

// ============================================================================
// FrameModel types
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
  readonly pipelineState: DrawPipelineState;
  /**
   * Bound vertex buffers keyed by slot. Each entry carries `handleId` +
   * `offset` + `size` from the raw `setVertexBuffer` event (offset defaults
   * to 0; size 0 keeps the WebGPU "to end of buffer" convention verbatim).
   * AI users read offset / size directly here without re-scanning tape events.
   */
  readonly vertexBuffers: ReadonlyMap<
    number,
    { readonly handleId: HandleId; readonly offset: number; readonly size: number }
  >;
  /**
   * Bound index buffer at this draw (mirrors `setIndexBuffer` event); absent
   * when the pass never issued one. Only meaningful for `drawIndexed` /
   * `drawIndexedIndirect` — non-indexed draws leave it dangling; consumers
   * cross-reference `drawCall.kind` if they need it. Truly optional so viewer
   * fixtures can omit it entirely.
   */
  readonly indexBuffer?: { handleId: HandleId; format: GPUIndexFormat; offset: number } | undefined;
  readonly depthStencil: DrawDepthStencil;
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

/** Summary metadata about the tape. */
export interface FrameModelMeta {
  readonly totalDraws: number;
  readonly totalPasses: number;
  readonly hasCompute: boolean;
}

/** The complete frame model. The viewer exposes it as window.__forgeaxViewer. */
export interface FrameModel {
  readonly tree: readonly PassNode[];
  readonly draws: readonly DrawEntry[];
  readonly meta: FrameModelMeta;
  /** Full command stream in tape order (includes non-draw events). */
  readonly commands: readonly CommandEntry[];
  /** handleId to parsed create descriptor. */
  readonly resources: ReadonlyMap<HandleId, CreateDescriptor>;
}

// ============================================================================
// Event-kind extraction
// ============================================================================

const META_KINDS = new Set(['frameMark', 'submit', 'finish', 'createCommandEncoder']);

function eventKindAt(
  events: readonly RhiCallEvent[],
  globalDrawIdx: number,
): PassDrawItem['eventKind'] {
  let idx = 0;
  for (const event of events) {
    if (DRAW_KINDS.has(event.kind)) {
      if (idx === globalDrawIdx) {
        return event.kind as PassDrawItem['eventKind'];
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
    if (DRAW_KINDS.has(event.kind)) count++;
  }
  return count;
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

// ============================================================================
// buildFrameModel
// ============================================================================

const EMPTY_PASS_STATE = {
  handleId: '',
  pipelineHandleId: undefined,
  vertexBuffers: new Map<number, { handleId: HandleId; offset: number; size: number }>(),
  indexBuffer: undefined,
  blendConstant: undefined,
  stencilReference: 0,
  depthStencilViewHandleId: undefined,
  depthStencilAttachment: undefined,
};

/**
 * Compute the FrameModel from a Tape (pure, no GPU).
 *
 * Produces the full tree structure, per-draw bindings/drawCall/pipelineState,
 * the resources map, and the full command stream from pure event traversal,
 * reusing the computePassOffsets / extractDrawInfo / findPassIdx primitives and
 * the inspect-core scanPassStates / makePipelineState / buildResources atoms.
 */
export function buildFrameModel(tape: Tape): FrameModel {
  const events = tape.events;

  // Step 1: pass offsets
  const offsets = computePassOffsets(events);

  // Step 2: tree from offsets
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

  // Step 3: pre-scan resources + pass states
  const resources = buildResources(events);
  const passStates = scanPassStates(events);

  // Step 4: per-draw entries
  const totalDraws = countDrawEvents(events);
  const draws: DrawEntry[] = [];
  let hasCompute = false;

  for (let i = 0; i < totalDraws; i++) {
    const info = extractDrawInfo(events, i);
    const passIdx = findPassIdx(events, i);

    const passState = passStates[passIdx];
    const pipelineState = makePipelineState(
      passState?.pipelineHandleId,
      resources,
      passState ?? EMPTY_PASS_STATE,
    );
    const vertexBuffers = passState?.vertexBuffers ?? new Map();
    const indexBuffer = passState?.indexBuffer;
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
      indexBuffer,
      depthStencil,
    });

    if (info.drawCall.pipelineKind === 'compute') {
      hasCompute = true;
    }
  }

  // Step 5: command stream
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

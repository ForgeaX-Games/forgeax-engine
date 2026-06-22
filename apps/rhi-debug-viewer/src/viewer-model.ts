// viewer-model.ts — buildViewModel: budget-phase ViewModel computation (zero React, zero GPU).
//
// Pure function of Tape -> ViewModel. Two-stage design:
//   1. Budget phase (this module): computePassOffsets + extractDrawInfo → full tree + draws.
//      All bindings/drawCall data is stored; no GPU interaction.
//   2. Lazy phase (M4 RtPanel): renderRtToCanvas fills RT pixels on draw selection.
//
// Zero-copy per D-4: window.__forgeaxViewer = vm exposes the same object reference,
// not a field-by-field copy. AC-14 enforcement point: page.evaluate must return
// the same structural identity.
//
// AC-02: tree pass/draw counts MUST equal computePassOffsets direct computation —
// buildViewModel uses computePassOffsets, never a separate hand-written counter.
//
// Related: plan-strategy D-4 (zero-copy); AC-02/AC-03/AC-04/AC-05/AC-11/AC-14/AC-17.

import type {
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
  readonly eventKind: 'draw' | 'drawIndexed' | 'dispatchWorkgroups';
}

/** A pass node in the tree — render or compute pass. */
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
}

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
      event.kind === 'dispatchWorkgroups'
    ) {
      count++;
    }
  }
  return count;
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
 * @param tape - The deserialized tape to analyse.
 * @returns ViewModel with tree, draws, and meta.
 */
export function buildViewModel(tape: Tape): ViewModel {
  const events = tape.events;

  // Step 1: build pass offsets (M1 extended — render+compute mixed)
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

  // Step 3: build per-draw entries via extractDrawInfo + findPassIdx
  const totalDraws = countDrawEvents(events);
  const draws: DrawEntry[] = [];
  let hasCompute = false;

  for (let i = 0; i < totalDraws; i++) {
    const info = extractDrawInfo(events, i);
    const passIdx = findPassIdx(events, i);

    draws.push({
      frameIdx: info.frameIdx,
      passIdx,
      bindings: info.bindings,
      drawCall: info.drawCall,
      colorAttachmentHandleId: info.colorAttachmentHandleId,
    });

    if (info.drawCall.pipelineKind === 'compute') {
      hasCompute = true;
    }
  }

  return {
    tree,
    draws,
    meta: {
      totalDraws,
      totalPasses: offsets.length,
      hasCompute,
    },
  };
}

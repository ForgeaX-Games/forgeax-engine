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
import { computePassOffsets } from './tape-format';
import type {
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
// extractDrawInfo
// ============================================================================

/**
 * Extract draw information from tape events up to a given draw index.
 *
 * Walks events from start, tracking frameMark boundaries, bind group state,
 * and the current render pass setup to produce the InspectReport fields.
 */
export function extractDrawInfo(events: readonly RhiCallEvent[], targetDrawIdx: number): DrawInfo {
  let frameIdx = 0;
  let currentGlobalDrawIdx = 0;
  let foundDraw = false;

  // Track bind group state per index (most recent setBindGroup)
  const bindGroups = new Map<number, InspectBindingEntry[]>();

  // I-8 fix (round 1 implement-review): index createBindGroup events by
  // handleId so setBindGroup can resolve to the real per-entry kind +
  // resourceHandleId list (covers cubemap, sampler, multi-buffer mixes;
  // AC-29 requires Sponza skylight cubemap to surface as a texture/
  // textureView entry, not a collapsed dummy 'buffer').
  const bindGroupDefs = new Map<
    string,
    {
      readonly entries: readonly {
        readonly binding: number;
        readonly resourceKind: 'sampler' | 'buffer' | 'textureView' | 'externalTexture';
      }[];
      readonly resourceHandleIds: readonly string[];
    }
  >();

  // Track the last color attachment from beginRenderPass
  let lastColorAttachmentHandleId: string | undefined;
  // Track whether we saw a setPipeline event (for draw call kind)
  const lastSeenPerPass: Map<
    string,
    { pipelineKind: 'render' | 'compute'; pipelineHandleId: string }
  > = new Map();
  let currentPassHandleId: string | undefined;

  let drawBindings: InspectBindingEntry[] = [];
  let drawCall: InspectDrawCall | null = null;
  let drawPassHandleId: string | undefined;

  for (const event of events) {
    if (event.kind === 'frameMark') {
      frameIdx = event.frameIdx;
    }

    // Track pass boundaries
    if (event.kind === 'beginRenderPass') {
      currentPassHandleId = event.passHandleId;
      lastColorAttachmentHandleId = event.colorAttachmentViewHandleIds[0] ?? undefined;
    } else if (event.kind === 'endRenderPass') {
      currentPassHandleId = undefined;
    }

    if (event.kind === 'setPipeline') {
      if (currentPassHandleId !== undefined) {
        lastSeenPerPass.set(currentPassHandleId, {
          pipelineKind: 'render',
          pipelineHandleId: event.pipelineHandleId,
        });
      }
    } else if (event.kind === 'setComputePipeline') {
      if (currentPassHandleId !== undefined) {
        lastSeenPerPass.set(currentPassHandleId, {
          pipelineKind: 'compute',
          pipelineHandleId: event.pipelineHandleId,
        });
      }
    }

    // I-8: stash createBindGroup definitions so setBindGroup can resolve
    // back to the per-entry shape.
    if (event.kind === 'createBindGroup') {
      bindGroupDefs.set(event.handleId, {
        entries: event.entries,
        resourceHandleIds: event.resourceHandleIds,
      });
    }

    if (event.kind === 'setBindGroup') {
      // I-8: resolve setBindGroup -> createBindGroup definition. Each
      // tracked entry uses its real resourceKind (cubemap/sampler/buffer)
      // and the resourceHandleId from the createBindGroup event. If no
      // matching definition is found (e.g. tape truncation), fall back
      // to a single placeholder entry pointing at the bindGroup itself
      // so the contract `bindings[].handleId` stays non-empty.
      const def = bindGroupDefs.get(event.bindGroupHandleId);
      if (def !== undefined) {
        const resolved: InspectBindingEntry[] = def.entries.map((e, idx) => ({
          groupIndex: event.index,
          entryIndex: e.binding,
          handleId: def.resourceHandleIds[idx] ?? event.bindGroupHandleId,
          kind: mapResourceKindToInspectKind(e.resourceKind),
        }));
        bindGroups.set(event.index, resolved);
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

    // Check for draw calls
    if (
      event.kind === 'draw' ||
      event.kind === 'drawIndexed' ||
      event.kind === 'dispatchWorkgroups'
    ) {
      if (currentGlobalDrawIdx === targetDrawIdx) {
        foundDraw = true;
        drawPassHandleId = currentPassHandleId;

        // Collect all current bind group entries
        const entries: InspectBindingEntry[] = [];
        for (const bgEntry of bindGroups.values()) {
          entries.push(...bgEntry);
        }
        drawBindings = entries;

        // Build draw call
        const pipelineInfo =
          drawPassHandleId !== undefined ? lastSeenPerPass.get(drawPassHandleId) : undefined;

        if (event.kind === 'draw') {
          drawCall = {
            pipelineKind: pipelineInfo?.pipelineKind ?? 'render',
            pipelineHandleId: pipelineInfo?.pipelineHandleId ?? 'unknown',
            vertexCount: event.vertexCount,
            instanceCount: event.instanceCount,
          };
        } else if (event.kind === 'drawIndexed') {
          drawCall = {
            pipelineKind: pipelineInfo?.pipelineKind ?? 'render',
            pipelineHandleId: pipelineInfo?.pipelineHandleId ?? 'unknown',
            indexCount: event.indexCount,
            instanceCount: event.instanceCount,
          };
        } else {
          drawCall = {
            pipelineKind: pipelineInfo?.pipelineKind ?? 'compute',
            pipelineHandleId: pipelineInfo?.pipelineHandleId ?? 'unknown',
            dispatchX: event.x,
            dispatchY: event.y,
            dispatchZ: event.z,
          };
        }
        break;
      }
      currentGlobalDrawIdx++;
    }
  }

  if (!foundDraw || drawCall === null) {
    return {
      frameIdx,
      passIdx: -1,
      bindings: [],
      drawCall: {
        pipelineKind: 'render',
        pipelineHandleId: 'unknown',
      },
      colorAttachmentHandleId: undefined,
    };
  }

  return {
    frameIdx,
    passIdx: -1, // Will be computed by findPassIdx
    bindings: drawBindings,
    drawCall,
    colorAttachmentHandleId: lastColorAttachmentHandleId,
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
    if (ev.kind === 'draw' || ev.kind === 'drawIndexed' || ev.kind === 'dispatchWorkgroups') {
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

  return ok(result);
}

/** Strip `readonly` so the cropped report can be built field by field. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

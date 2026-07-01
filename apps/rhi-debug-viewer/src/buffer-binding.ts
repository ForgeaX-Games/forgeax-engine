// buffer-binding.ts — buffer↔draw binding relation extraction (w11).
//
// Pure functions analyzing DrawEntry + raw events to build
// bufferHandleId → consumer list mappings for:
//   (a) vertex buffer slot → draw
//   (b) index buffer → draw
//   (c) bind group binding → buffer
//
// Related: requirements AC-06; plan-strategy D-7; research Finding 7.

import type { RhiCallEvent } from '@forgeax/engine-rhi-debug';
import type { DrawEntry } from '@forgeax/engine-rhi-debug/frame-model';

type HandleId = string;

// ---------------------------------------------------------------------------
// Consumer type
// ---------------------------------------------------------------------------

export type BufferConsumerRole = 'vertex' | 'index' | 'bindGroup';

export interface BufferConsumer {
  readonly drawIdx: number;
  readonly passIdx: number;
  readonly role: BufferConsumerRole;
  /** Vertex buffer slot (for role='vertex'). */
  readonly slot?: number | undefined;
  /** Vertex buffer stride (placeholder — not in DrawEntry yet). */
  readonly stride?: number | undefined;
  /** Bind group index (for role='bindGroup'). */
  readonly groupIndex?: number | undefined;
  /** Bind group entry index (for role='bindGroup'). */
  readonly entryIndex?: number | undefined;
  /** Human-readable details string. */
  readonly details: string;
}

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Build a map from buffer handleId to its consumer list.
 *
 * Three data paths:
 *   1. Vertex buffers — from DrawEntry.vertexBuffers (slot → bufferHandleId).
 *      Iterate all draws, collect per-slot refs.
 *   2. Index buffers — scan raw events for setIndexBuffer per pass,
 *      match to draw via passIdx ordering.
 *   3. Bind groups — scan createBindGroup + setBindGroup events,
 *      link buffer resource entries to draws via passIdx + group index.
 */
export function bufferBindingConsumers(
  draws: readonly DrawEntry[],
  events: readonly RhiCallEvent[],
): Map<HandleId, readonly BufferConsumer[]> {
  const consumers = new Map<HandleId, BufferConsumer[]>();

  const ensure = (hid: HandleId): BufferConsumer[] => {
    let arr = consumers.get(hid);
    if (!arr) {
      arr = [];
      consumers.set(hid, arr);
    }
    return arr;
  };

  // ---- 1. Vertex buffers ----
  for (let di = 0; di < draws.length; di++) {
    const draw = draws[di];
    if (!draw) continue;
    for (const [slot, bufferHandleId] of draw.vertexBuffers) {
      const arr = ensure(bufferHandleId);
      arr.push({
        drawIdx: di,
        passIdx: draw.passIdx,
        role: 'vertex',
        slot,
        details: `vertex slot=${slot}`,
      });
    }
  }

  // ---- 2. Index buffers ----
  // scan raw events for setIndexBuffer by pass
  const passIndexBuffers = new Map<number, { bufferHandleId: HandleId; format: string }>();
  for (const event of events) {
    if (event.kind === 'setIndexBuffer') {
      // Find the passIdx from the passHandleId (approximate: count begin*Pass before this event)
      const passIdx = countPassIdxFromEvents(events, event.passHandleId);
      if (passIdx >= 0) {
        passIndexBuffers.set(passIdx, {
          bufferHandleId: event.bufferHandleId,
          format: event.format,
        });
      }
    }
  }

  for (let di = 0; di < draws.length; di++) {
    const draw = draws[di];
    if (!draw) continue;
    const ib = passIndexBuffers.get(draw.passIdx);
    if (ib) {
      const arr = ensure(ib.bufferHandleId);
      arr.push({
        drawIdx: di,
        passIdx: draw.passIdx,
        role: 'index',
        details: `index ${ib.format}`,
      });
    }
  }

  // ---- 3. Bind group bindings ----
  // index createBindGroup by handleId
  const bindGroupEntries = new Map<
    HandleId,
    {
      layoutHandleId: HandleId;
      entries: readonly {
        binding: number;
        resourceKind: string;
        bufferOffset?: number;
        bufferSize?: number;
      }[];
      resourceHandleIds: readonly HandleId[];
    }
  >();
  for (const event of events) {
    if (event.kind === 'createBindGroup') {
      bindGroupEntries.set(event.handleId, {
        layoutHandleId: event.layoutHandleId,
        entries: event.entries,
        resourceHandleIds: event.resourceHandleIds,
      });
    }
  }

  // iterate setBindGroup events, match to draw by passIdx + group index
  for (const event of events) {
    if (event.kind === 'setBindGroup') {
      const passIdx = countPassIdxFromEvents(events, event.passHandleId);
      if (passIdx < 0) continue;

      const bg = bindGroupEntries.get(event.bindGroupHandleId);
      if (!bg) continue;

      // For each entry that is a buffer, link to relevant draws in this pass
      for (let ei = 0; ei < bg.entries.length; ei++) {
        const entry = bg.entries[ei];
        if (!entry) continue;
        if (entry.resourceKind !== 'buffer') continue;

        const bufferHandleId = bg.resourceHandleIds[ei];
        if (!bufferHandleId) continue;

        // Find draws in this pass
        for (let di = 0; di < draws.length; di++) {
          const draw = draws[di];
          if (!draw || draw.passIdx !== passIdx) continue;

          const arr = ensure(bufferHandleId);
          const detailParts: string[] = [`bindGroup group=${event.index}`];
          if (entry.binding !== undefined) {
            detailParts.push(`binding=${entry.binding}`);
          }
          if (entry.bufferOffset !== undefined) {
            detailParts.push(`offset=${entry.bufferOffset}`);
          }
          if (entry.bufferSize !== undefined) {
            detailParts.push(`size=${entry.bufferSize}`);
          }

          arr.push({
            drawIdx: di,
            passIdx: draw.passIdx,
            role: 'bindGroup',
            groupIndex: event.index,
            entryIndex: entry.binding,
            details: detailParts.join(', '),
          });
        }
      }
    }
  }

  return consumers;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countPassIdxFromEvents(
  events: readonly RhiCallEvent[],
  targetPassHandleId: string,
): number {
  let passIdx = -1;
  for (const event of events) {
    if (event.kind === 'beginRenderPass' || event.kind === 'beginComputePass') {
      passIdx++;
      if (event.passHandleId === targetPassHandleId) {
        return passIdx;
      }
    }
  }
  return -1;
}

// @forgeax/engine-rhi-debug/src/adapter -- production wiring factory
// (createDebugRhiAdapter). Three RPC surfaces: captureFrames / inspectAt /
// replayDispose.
//
// w10: rpc-bridge.ts deleted alongside routing layer removal. DebugRhiAdapter
// type (formerly in rpc-bridge.ts) now lives in index.ts barrel.

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RhiDevice } from '@forgeax/engine-rhi';
import { DebugError } from './errors';
import type { DebugRhiAdapter } from './index';
import { InspectorCache, inspectAt as runInspectAt } from './inspector';
import type { DebugRhiInstance } from './recorder';
import { waitForRecorderIdle } from './recorder-core';
import { createReplay, type Replay } from './replayer';
import { deserializeTape } from './tape-format';
import type { InspectFields } from './types';

/**
 * Construction inputs for the adapter. The host wires:
 *   - debugInst: the recorder proxy returned by `wrap(realRhi)` during
 *     FORGEAX_ENGINE_RHI_DEBUG=1 bootstrap.
 *   - device: the live `RhiDevice` the renderer drives. Used as the
 *     replay target (same-device replay = same caps; AC-14 dawn-node
 *     epsilon <= 0.01 holds).
 *   - cache: optional override for tests; defaults to a fresh
 *     `InspectorCache`. AC-21 LRU max size 2 stays enforced by the cache.
 */
export interface CreateDebugRhiAdapterArgs {
  readonly debugInst: DebugRhiInstance;
  readonly device: RhiDevice;
  readonly cache?: InspectorCache;
}

/**
 * Produce a DebugRhiAdapter that routes captureFrame / inspectAt /
 * replayDispose RPC calls through the live recorder + a cached replay
 * pipeline.
 *
 * captureFrames implementation note: arm() returns the recorder to the
 * armed state; subsequent frames executed by the host's render loop
 * trigger onFrameEnd, which transitions to recording and ultimately back
 * to idle once `frames` frame-marks have been emitted. The adapter
 * polls `getState()` because the recorder does not (and should not)
 * carry an EventEmitter for this single internal transition; the poll
 * interval (16 ms) tracks one rAF tick. Times out after 30 seconds to
 * surface a `recorder-not-attached` style failure rather than hang the
 * RPC indefinitely.
 */
export function createDebugRhiAdapter(args: CreateDebugRhiAdapterArgs): DebugRhiAdapter {
  const { debugInst, device } = args;
  const cache = args.cache ?? new InspectorCache();
  const replayDeviceMap = new Map<string, RhiDevice>();

  return {
    async captureFrames(frames: number, _label?: string) {
      const armResult = debugInst.arm(frames);
      if (!armResult.ok) {
        throw armResult.error;
      }

      // Frame-header snapshot (roadmap Phase 1 §5, wires the snapshot loop into
      // the real capture flow — the "M4" seam noted at recorder.ts onFrameEnd).
      // Resources uploaded during the loading phase (VBO/IBO/instance buffers)
      // were writeBuffer'd BEFORE arm(), so the recorder never saw those writes;
      // without seeding their bytes into initialData events the replayed buffers
      // are all-zero -> vertices collapse to the origin -> black RT. Snapshotting
      // advances Armed -> Snapshotting -> Recording and must complete before the
      // first frame's commands record (it drains in-flight writes via
      // onSubmittedWorkDone, so the captured bytes are the pre-frame content).
      const snapResult = await debugInst.snapshotAllLiveResources();
      if (!snapResult.ok) {
        throw snapResult.error;
      }

      // Wait until recorder finishes the requested frames. The host's
      // rAF loop drives onFrameEnd; the recorder transitions back to
      // idle once `frames` frame-marks have been emitted.
      await waitForRecorderIdle(debugInst, 30_000);

      const finalizeResult = debugInst.finalize();
      if (!finalizeResult.ok) {
        throw finalizeResult.error;
      }

      const { runId, tapePath, reportPath } = finalizeResult.value;
      // For v1 the recorder finalizes to a single tape file even when
      // `frames > 1`; the report carries pass offsets per frame.
      return {
        tapes: [
          {
            frameIdx: 0,
            runId,
            tapePath,
            reportPath,
          },
        ],
      };
    },

    async inspectAt(tapePath: string, drawIdx: number, fields?: readonly InspectFields[]) {
      // On-disk schema (recorder finalize):
      //   .forgeax-debug/<runId>/frame-0.tape.bin   -> raw blob pool bytes
      //   .forgeax-debug/<runId>/frame-0.report.json -> { header, events, passOffsets, valid }
      // Reassemble both into the JSON form deserializeTape() expects.
      const blobBuf = await fs.promises.readFile(tapePath);
      const reportPath = tapePath.replace(/\.tape\.bin$/, '.report.json');
      const reportRaw = await fs.promises.readFile(reportPath, 'utf-8');
      let reportObj: { header: unknown; events: unknown };
      try {
        reportObj = JSON.parse(reportRaw) as { header: unknown; events: unknown };
      } catch {
        throw new DebugError({
          code: 'tape-format-version-mismatch',
          expected: 'parseable JSON report file alongside the tape binary',
          hint: `failed to parse '${reportPath}'`,
        });
      }
      const json = JSON.stringify({ header: reportObj.header, events: reportObj.events });
      const blob = new Uint8Array(blobBuf.buffer, blobBuf.byteOffset, blobBuf.byteLength).slice();
      const tapeResult = deserializeTape(json, blob);
      if (!tapeResult.ok) {
        throw tapeResult.error;
      }
      const tape = tapeResult.value;

      const entry = cache.getOrCreate(tapePath, () => {
        const replayResult = createReplay(tape, device);
        if (!replayResult.ok) {
          throw replayResult.error;
        }
        replayDeviceMap.set(tapePath, device);
        return replayResult.value;
      });

      // Map drawIdx (the Nth draw call in the tape) to its event
      // index — replay.stepTo takes an event index, not a draw index.
      // Walk events linearly counting draw / drawIndexed /
      // dispatchWorkgroups occurrences until we hit drawIdx.
      const targetEventIdx = findEventIdxForDraw(tape.events, drawIdx);
      if (targetEventIdx === -1) {
        throw new DebugError({
          code: 'replay-step-out-of-range',
          expected: `drawIdx ${drawIdx} present in tape (totalDrawCalls < ${drawIdx + 1})`,
          hint: 'tape contains fewer draw calls than the requested drawIdx',
          detail: {
            requestedStep: drawIdx,
            currentStep: entry.currentEventIdx,
            totalEvents: tape.events.length,
          },
        });
      }
      // Step the replay forward to targetEventIdx. Resets when stepping
      // backwards is required (cache hit on an earlier draw).
      if (targetEventIdx < entry.currentEventIdx) {
        entry.replay.reset();
        entry.currentEventIdx = 0;
      }
      const stepResult = await entry.replay.stepTo(targetEventIdx);
      if (!stepResult.ok) {
        throw stepResult.error;
      }
      entry.currentEventIdx = targetEventIdx + 1;

      // Inspect with the requested fields. The PNG outputDir is the
      // same .forgeax-debug/<runId>/ directory that finalize() wrote to.
      const outputDir = path.dirname(tapePath);
      const reportResult = await runInspectAt(
        entry.replay,
        drawIdx,
        tape.events,
        fields,
        device,
        outputDir,
      );
      if (!reportResult.ok) {
        throw reportResult.error;
      }
      // RPC payload is a plain object — strip readonly + return.
      return reportResult.value as unknown as Record<string, unknown>;
    },

    async replayDispose(tapePath: string) {
      const replay: Replay | undefined = (
        cache as unknown as {
          _cache: Map<string, { replay: Replay }>;
        }
      )._cache.get(tapePath)?.replay;
      cache.dispose(tapePath);
      // dispose is fire-and-forget on the underlying Replay; cache.dispose
      // routes through the dispose-busy guard.
      if (replay !== undefined) {
        replayDeviceMap.delete(tapePath);
      }
      return { ok: true };
    },
  };
}

// ============================================================================
// Helpers
// ============================================================================

function findEventIdxForDraw(
  events: readonly import('./types').RhiCallEvent[],
  drawIdx: number,
): number {
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

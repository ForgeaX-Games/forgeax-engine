// @forgeax/engine-rhi-debug/src/inspector -- inspectAt(replay, drawIdx, fields?) + LRU cache.
//
// Core features (M6):
// - inspectAt: fields cropping ('bindings'/'drawCall'/'rt') with optional RT PNG readback.
// - LRU cache (size=2) keyed by tapePath, with dispose-busy race protection.
// - RT PNG readback via copyTextureToBuffer + mapAsync + pngjs encode.
// - Pass PNG on-demand generation from .report.json pass index.
//
// Related: requirements AC-15/AC-19/AC-20/AC-21/AC-26/AC-27; m6-1/m6-2/m6-3.

/// <reference types="@webgpu/types" />

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { RhiDevice } from '@forgeax/engine-rhi';
import type { Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { DebugError } from './errors';
import { inspectDrawJson } from './inspect-core';
import { readbackDrawRt } from './readback';
import type { Replay } from './replayer';
import { computePassOffsets } from './tape-format';
import type { InspectFields, InspectReport, RhiCallEvent } from './types';

// ============================================================================
// Constants
// ============================================================================

const LRU_MAX_SIZE = 2;

// ============================================================================
// InspectorCache -- LRU cache keyed by tapePath (m6-2)
// ============================================================================

interface ReplayCacheEntry {
  readonly replay: Replay;
  currentEventIdx: number;
  lastAccessTs: number;
}

/**
 * LRU cache of Replay objects keyed by tapePath.
 *
 * Max size = 2 (AC-21). On third unique tape, the oldest (by lastAccessTs)
 * entry is evicted and its replay.dispose() is called.
 *
 * dispose-busy protection (m6-2): if dispose() is called while there are
 * in-flight inspectAt calls for the same tapePath, the dispose is rejected
 * with code='replay-dispose-busy'.
 */
export class InspectorCache {
  /** @internal */
  // biome-ignore lint/style/useNamingConvention: package-internal field requires _ prefix per AGENTS.md lint:internal rule (R-internal-C)
  private readonly _cache = new Map<string, ReplayCacheEntry>();
  /** @internal */
  // biome-ignore lint/style/useNamingConvention: package-internal field requires _ prefix per AGENTS.md lint:internal rule (R-internal-C)
  private readonly _inFlight = new Map<string, Set<number>>();

  get size(): number {
    return this._cache.size;
  }

  /**
   * Get or create a ReplayCacheEntry for the given tapePath.
   * If the entry doesn't exist, it is created and inserted into the cache.
   * If inserting would exceed LRU_MAX_SIZE, the oldest entry is evicted.
   */
  getOrCreate(tapePath: string, factory: () => Replay): ReplayCacheEntry {
    const existing = this._cache.get(tapePath);
    if (existing !== undefined) {
      existing.lastAccessTs = Date.now();
      return existing;
    }

    // Evict oldest if at capacity
    if (this._cache.size >= LRU_MAX_SIZE) {
      this._evictOldest();
    }

    const replay = factory();
    const entry: ReplayCacheEntry = {
      replay,
      currentEventIdx: 0,
      lastAccessTs: Date.now(),
    };
    this._cache.set(tapePath, entry);
    return entry;
  }

  /**
   * Mark a drawIdx as in-flight for the given tapePath.
   */
  markInFlight(tapePath: string, drawIdx: number): void {
    let inflight = this._inFlight.get(tapePath);
    if (inflight === undefined) {
      inflight = new Set();
      this._inFlight.set(tapePath, inflight);
    }
    inflight.add(drawIdx);
  }

  /**
   * Clear a drawIdx from in-flight tracking.
   */
  clearInFlight(tapePath: string, drawIdx: number): void {
    const inflight = this._inFlight.get(tapePath);
    if (inflight !== undefined) {
      inflight.delete(drawIdx);
      if (inflight.size === 0) {
        this._inFlight.delete(tapePath);
      }
    }
  }

  /**
   * Get the set of in-flight draw indices for a tapePath.
   */
  getInFlight(tapePath: string): Set<number> {
    return this._inFlight.get(tapePath) ?? new Set();
  }

  /**
   * Dispose and remove the cache entry for a tapePath.
   *
   * If there are in-flight inspectAt calls for this tape, reject with
   * 'replay-dispose-busy' containing the in-flight draw indices.
   */
  dispose(tapePath: string): Result<void, DebugError> {
    const inflight = this._inFlight.get(tapePath);
    if (inflight !== undefined && inflight.size > 0) {
      return err(
        new DebugError({
          code: 'replay-dispose-busy',
          expected: 'no in-flight inspectAt calls for this tape',
          hint: `await the in-flight inspectAt calls for draw indices [${Array.from(inflight).join(', ')}] before calling dispose`,
          detail: {
            inFlightDrawIndices: Array.from(inflight),
          },
        }),
      );
    }

    const entry = this._cache.get(tapePath);
    if (entry !== undefined) {
      entry.replay.dispose();
      this._cache.delete(tapePath);
    }

    return ok(undefined);
  }

  /**
   * Evict the least-recently-used entry from the cache.
   * @internal
   */
  // biome-ignore lint/style/useNamingConvention: package-internal method requires _ prefix per AGENTS.md lint:internal rule (R-internal-C); @internal JSDoc above
  private _evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTs = Infinity;

    for (const [key, entry] of this._cache) {
      if (entry.lastAccessTs < oldestTs) {
        oldestTs = entry.lastAccessTs;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      // Skip busy check on eviction -- eviction is cache-internal,
      // not a user-requested dispose. Just dispose and remove.
      const entry = this._cache.get(oldestKey);
      if (entry !== undefined) {
        entry.replay.dispose();
      }
      this._cache.delete(oldestKey);
    }
  }
}

// ============================================================================
// inspectAt (m6-1 + m6-3)
// ============================================================================

/**
 * Inspect a specific drawIdx within a replay session.
 *
 * @param replay - The Replay session that has been stepped to at least drawIdx.
 * @param drawIdx - The global draw event index to inspect.
 * @param events - The tape events array (for extracting frame/pass info).
 * @param fields - Which fields to compute and include in the report.
 *   - ['bindings']: only bind group info, no RT readback.
 *   - ['drawCall']: only draw call metadata.
 *   - ['rt']: triggers copyTextureToBuffer + PNG encode.
 *   - undefined: full report with all fields including RT.
 * @param device - The RhiDevice used for RT readback (needed for copyTextureToBuffer).
 * @param outputDir - The output directory for PNG files (inspect/ subfolder).
 * @returns InspectReport with the requested fields populated.
 */
export async function inspectAt(
  replay: Replay,
  drawIdx: number,
  events: readonly RhiCallEvent[],
  fields: readonly InspectFields[] | undefined,
  device: RhiDevice,
  outputDir: string,
): Promise<Result<InspectReport, DebugError>> {
  // Determine which fields to include
  const fieldSet = fields !== undefined ? new Set(fields) : undefined;
  const wantRt = fieldSet === undefined || fieldSet.has('rt');

  // Derive from inspectDrawJson for bindings/drawCall/passIdx (D-1 single SSOT).
  // Strip 'rt' from fields for the core call — PNG path is Node-specific.
  const fieldsWithoutRt: readonly InspectFields[] | undefined =
    fields !== undefined ? fields.filter((f) => f !== 'rt') : undefined;

  const reportResult = await inspectDrawJson(replay, drawIdx, events, device, fieldsWithoutRt);
  if (!reportResult.ok) {
    return err(reportResult.error);
  }
  const report = reportResult.value;

  // Patch RT: if rt was requested, call readbackAndEncodePng (Node-specific PNG
  // encode) and set the rt field to the PNG file path. On the Node CLI path the
  // InspectRtPayload union resolves to its `string` (PNG path) arm — distinct
  // from the browser path's {width,height,pixels} arm. Cast only relaxes
  // `readonly rt`; the assigned string is a valid InspectRtPayload.
  if (wantRt) {
    const pngResult = await readbackAndEncodePng(replay, drawIdx, device, outputDir);
    if (!pngResult.ok) {
      return err(pngResult.error);
    }
    (report as { rt?: InspectReport['rt'] }).rt = pngResult.value;
  }

  return ok(report);
}

// ============================================================================
// RT readback + PNG encode (m6-3)
// ============================================================================

/**
 * Read back the color attachment RT from a replay after stepping to drawIdx,
 * and encode it as PNG.
 *
 * Steps:
 * 1. reset() replay to start
 * 2. Find the last beginRenderPass before drawIdx -> get color attachment handle
 * 3. stepTo the event index just after the draw call
 * 4. Create a readback buffer
 * 5. Create a command encoder, copyTextureToBuffer, submit
 * 6. await onSubmittedWorkDone
 * 7. mapAsync readback buffer
 * 8. getMappedRange, encode PNG, write file
 * 9. unmap buffer, destroy temp resources
 *
 * @returns Ok(pngFilePath) or Err(DebugError) on readback/encode failure.
 */
async function readbackAndEncodePng(
  replay: Replay,
  drawIdx: number,
  device: RhiDevice,
  outputDir: string,
): Promise<Result<string, DebugError>> {
  // Ensure output directory exists
  const inspectDir = path.join(outputDir, 'inspect');
  try {
    await fs.promises.mkdir(inspectDir, { recursive: true });
  } catch {
    // Directory may already exist -- that's fine
  }

  // Delegate GPU readback to readbackDrawRt (shared SSOT, D-2).
  // The 530-622 segment moved to readback.ts (w3) — inspector now derives
  // from a single call and retains only the Node-specific PNG encode +
  // fs.writeFile path (AC-04).
  const rtResult = await readbackDrawRt(replay, drawIdx, device);
  if (!rtResult.ok) {
    return err(rtResult.error);
  }
  const { width: texWidth, height: texHeight, pixels } = rtResult.value;

  // Encode PNG (use lazy import of pngjs for tree-shake friendliness)
  const pngFilePath = path.join(inspectDir, `d${String(drawIdx).padStart(4, '0')}-rt0.png`);

  try {
    // pngjs is a Node.js library (util/stream builtins). This module is the
    // node-only `./inspector` subpath -- never in the capture-browser import
    // closure -- and pngjs is declared `external` in tsup.config.ts, so a
    // plain dynamic import stays un-bundled in every build while still
    // resolving under the vitest VM (the prior `new Function(...import...)`
    // eval-shim threw ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING under vitest,
    // blocking the offline-inspect dawn e2e; m4 / w20). The capture-browser
    // tree-shake gate (AC-10) is unaffected -- it greps capture-browser.mjs,
    // which does not import this module.
    const { PNG } = (await import('pngjs')) as typeof import('pngjs');
    const png = new PNG({ width: texWidth, height: texHeight });
    // pixels is tight-packed RGBA (readbackTexturePixels already strips alignment padding)
    png.data.set(pixels);
    const pngBuffer = PNG.sync.write(png);
    await fs.promises.writeFile(pngFilePath, pngBuffer);
  } catch (e) {
    return err(
      new DebugError({
        code: 'png-encode-failed',
        expected: 'PNG encoding to succeed',
        hint: `pngjs encoding failed: ${String(e)}; the RT was successfully read back but could not be encoded as PNG`,
      }),
    );
  }

  return ok(pngFilePath);
}

// ============================================================================
// Pass PNG on-demand generation (m6-3)
// ============================================================================

/**
 * Generate a pass PNG file for the given pass index.
 *
 * Steps:
 * 1. Compute pass offsets from events
 * 2. Step replay to the end of the pass
 * 3. Read back the RT at the end of the pass
 * 4. Encode PNG to passes/{passIdx:04d}.png
 *
 * @param replay - The Replay session to step.
 * @param passIdx - The pass index to generate PNG for.
 * @param events - The tape events array.
 * @param device - The RhiDevice for RT readback.
 * @param outputDir - The output directory for PNG files.
 * @returns Ok(pngFilePath) if generated, or Ok(path) if already exists.
 */
export async function generatePassPng(
  replay: Replay,
  passIdx: number,
  events: readonly RhiCallEvent[],
  device: RhiDevice,
  outputDir: string,
): Promise<Result<string, DebugError>> {
  const passesDir = path.join(outputDir, 'passes');
  const pngFilePath = path.join(passesDir, `${String(passIdx).padStart(4, '0')}.png`);

  // Check if already exists
  try {
    await fs.promises.access(pngFilePath);
    return ok(pngFilePath);
  } catch {
    // File doesn't exist, need to generate
  }

  // Ensure directory exists
  try {
    await fs.promises.mkdir(passesDir, { recursive: true });
  } catch {
    // Directory may already exist
  }

  // Find the drawIdx at the end of the pass
  const offsets = computePassOffsets(events);
  const passOffsets = offsets.filter((o) => o.passIdx === passIdx);
  if (passOffsets.length === 0) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: `pass index ${passIdx} to exist in tape pass offsets`,
        hint: `no pass found at index ${passIdx}; available pass indices: ${offsets.map((o) => o.passIdx).join(', ')}`,
      }),
    );
  }

  const passOffset = passOffsets[0];
  if (passOffset === undefined) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: `pass index ${passIdx} to exist in tape pass offsets`,
        hint: `no pass found at index ${passIdx}; available pass indices: ${offsets.map((o) => o.passIdx).join(', ')}`,
      }),
    );
  }

  // Empty pass has no draw to step to — return a descriptive error.
  if (passOffset.endDrawIdx < passOffset.startDrawIdx) {
    return err(
      new DebugError({
        code: 'rt-readback-failed',
        expected: `pass index ${passIdx} to contain at least one draw/dispatch`,
        hint: `pass ${passIdx} is empty (no draw/dispatch calls); no RT to read back`,
      }),
    );
  }

  const drawIdx = passOffset.endDrawIdx;

  // Commit through the pass's last draw so the color attachment holds that pass's
  // committed pixels. (Previously this passed the global drawIdx to stepTo, which
  // expects an EVENT index, and never committed the pass — so non-final passes
  // read back wrong/uncommitted pixels. commitThroughDraw takes a draw index and
  // synthesizes the end+finish+submit.)
  const commitResult = await replay.commitThroughDraw(drawIdx);
  if (!commitResult.ok) {
    return err(commitResult.error);
  }

  // Read back and encode PNG
  const pngResult = await readbackAndEncodePng(replay, drawIdx, device, outputDir);
  if (!pngResult.ok) {
    return err(pngResult.error);
  }

  // Rename from inspect/ path to passes/ path
  try {
    await fs.promises.rename(pngResult.value, pngFilePath);
  } catch {
    // If rename fails (e.g., cross-device), copy then unlink
    await fs.promises.copyFile(pngResult.value, pngFilePath);
    try {
      await fs.promises.unlink(pngResult.value);
    } catch {
      // best effort cleanup
    }
  }

  return ok(pngFilePath);
}

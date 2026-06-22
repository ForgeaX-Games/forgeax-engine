// @forgeax/engine-rhi-debug/capture-browser -- node-free browser capture subpath.
//
// Purpose: the browser-side counterpart to the Node `finalize()` tail. Drives a
// live recorder through `arm -> waitForRecorderIdle -> finalizeToMemory`, then
// POSTs the in-memory tape to the vite-plugin-rhi-debug dev-server endpoint
// (`/__forgeax-debug/tape`), which writes it to disk byte-identically to the
// Node path (recorder-core.assembleReport is the D-3 single writer on both ends).
//
// Strict isolation (AC-10 / plan-strategy D-7): this module imports ONLY from
// `./recorder-core` + `./tape-format`, both of which are node-free. It must not
// import recorder / adapter / inspector, any Node builtin, or any Node-only
// dependency. The barrel (`index.ts`) deliberately does NOT re-export these
// symbols so the FORGEAX_ENGINE_RHI_DEBUG=0 tree-shake gate stays intact --
// consumers reach them only via the explicit
// `@forgeax/engine-rhi-debug/capture-browser` subpath.
//
// Related: requirements AC-10; plan-strategy D-7/D-8; OOS-8 (v1 single-frame).

import { finalizeToMemory, waitForRecorderIdle } from './recorder-core';
import type { PassOffset } from './tape-format';

/**
 * Minimal structural view of the recorder needed by browser capture.
 *
 * Defined locally (not imported from recorder.ts) so this module keeps zero
 * Node-builtin dependencies -- recorder.ts statically imports disk + path
 * builtins through its finalize() tail, which would defeat tree-shake isolation.
 */
export interface CaptureBrowserRecorder {
  arm(frames: number): { ok: true } | { ok: false; error: unknown };
  getState(): string;
  getEvents(): readonly unknown[];
  // biome-ignore lint/suspicious/noExplicitAny: structural view avoids importing recorder.ts (Node-builtin deps); finalizeToMemory accepts the same shape
  getTape(): any;
  /** @internal */
  _getValid(): boolean;
}

/** In-memory tape produced by `captureFramesToMemory`. */
export interface CaptureBrowserTape {
  readonly runId: string;
  readonly json: string;
  readonly blob: Uint8Array;
  readonly passOffsets: readonly PassOffset[];
  readonly valid: boolean;
}

/** Result of uploading a tape to the dev-server endpoint. */
export interface UploadTapeResult {
  readonly runId: string;
  readonly tapePath: string;
  readonly reportPath: string;
}

const TAPE_ROUTE = '/__forgeax-debug/tape';

/**
 * Capture `frames` frames into an in-memory tape (zero fs, zero network).
 *
 * Mirrors the adapter.ts `captureFrames` shape (D-7): arm the recorder, wait
 * for the host rAF loop to drive it back to idle, then finalize entirely in
 * memory. The caller uploads the result via `uploadTape`.
 *
 * OOS-8: v1 finalizes a single-frame tape; `frames` is accepted for forward
 * compatibility but the dev-server endpoint writes one tape file regardless.
 */
export async function captureFramesToMemory(
  debugInst: CaptureBrowserRecorder,
  frames: number,
  // `_label` is unused by the in-memory capture itself (mirrors adapter.ts
  // captureFrames(frames, _label?)); captureAndUpload forwards the caller's
  // label to uploadTape, which is where it lands on the dev-server run dir.
  _label?: string,
): Promise<CaptureBrowserTape> {
  const armResult = debugInst.arm(frames);
  if (!armResult.ok) {
    throw armResult.error;
  }

  await waitForRecorderIdle(debugInst, 30_000);

  const finalizeResult = finalizeToMemory(debugInst);
  if (!finalizeResult.ok) {
    throw finalizeResult.error;
  }
  return finalizeResult.value;
}

/**
 * Base64-encode a Uint8Array using only browser-safe primitives.
 *
 * Chunks the byte stream (8 KiB) before `String.fromCharCode(...)` so a large
 * blob does not blow the argument-count limit of the spread call. Uses `btoa`
 * (Window + Worker global) instead of node Buffer to keep this module node-free.
 */
function uint8ToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x2000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

/**
 * Upload an in-memory tape to the dev-server `/__forgeax-debug/tape` endpoint.
 *
 * The endpoint (vite-plugin-rhi-debug) decodes blobBase64, runs the D-3
 * single-writer report assembly, and writes both the tape blob and the report
 * JSON to disk, returning their paths. Non-2xx responses throw an Error
 * carrying the server envelope's `error` / `hint` so failures are actionable.
 *
 * `label` (optional) is forwarded as the body's `label` field; the dev-server
 * uses it to name the on-disk run directory.
 */
export async function uploadTape(
  tape: CaptureBrowserTape,
  label?: string,
): Promise<UploadTapeResult> {
  const body = {
    runId: tape.runId,
    ...(label !== undefined ? { label } : {}),
    json: tape.json,
    blobBase64: uint8ToBase64(tape.blob),
    passOffsets: tape.passOffsets,
    valid: tape.valid,
  };
  const response = await fetch(TAPE_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    let detail = '';
    try {
      const envelope = (await response.json()) as { error?: string; hint?: string };
      detail = ` (${envelope.error ?? 'unknown'}${envelope.hint !== undefined ? `: ${envelope.hint}` : ''})`;
    } catch {
      // Non-JSON error body; surface the bare status.
    }
    throw new Error(`uploadTape: dev-server returned ${response.status}${detail}`);
  }

  const result = (await response.json()) as UploadTapeResult;
  return result;
}

/**
 * Capture `frames` frames and upload the tape to the dev-server in one call.
 *
 * The convenience entry wired onto `globalThis.__forgeax.captureFrame` by
 * create-app.ts (canvas form, FORGEAX_ENGINE_RHI_DEBUG=1). Returns the
 * dev-server-written tape + report paths so a DevTools caller can open them.
 */
export async function captureAndUpload(
  debugInst: CaptureBrowserRecorder,
  frames: number,
  label?: string,
): Promise<UploadTapeResult> {
  const tape = await captureFramesToMemory(debugInst, frames, label);
  return uploadTape(tape, label);
}

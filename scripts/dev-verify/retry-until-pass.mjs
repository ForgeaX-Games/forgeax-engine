// scripts/dev-verify/retry-until-pass.mjs
//
// Shared crash-retry wrapper for the two WebKit probes
// (verify-webkit-hello-triangle.mjs + verify-webkit-r5-stability.mjs).
//
// Why: WebKit's wasm engine sporadically mis-executes the 4.5 MB
// wgpu_wasm_bg.wasm at cold-start, surfacing as two disjoint non-deterministic
// crash modes (naga IR miscompile OR a wgpu OOB amplified by parking_lot's
// single-threaded-wasm panic). Bisection proof: one immutable commit crashed at
// two different sites across its two CI attempts — same wasm bytes, same env.
// See docs/how-to/2026-07-06-webkit-fallback-flake-investigation.md.
//
// Only a result explicitly classified retryable gets another FRESH browser
// (the known crash is a per-process wasm memory fault; a new process recovers).
// Deterministic navigation, channel, pixel, or semantic failures stop after the
// first attempt instead of multiplying their timeout and log noise.

/**
 * @typedef {{ ok: boolean, summary: string, retryable?: boolean }} AttemptResult
 */

/**
 * Run attemptFn up to maxAttempts times while failures remain explicitly
 * retryable. attemptFn owns its own resources (browser launch/close) so each
 * retry is fully isolated.
 *
 * @param {(attemptNo: number) => Promise<AttemptResult>} attemptFn
 * @param {{ maxAttempts?: number, label: string }} opts
 * @returns {Promise<AttemptResult>}
 */
export async function runWithRetry(attemptFn, { maxAttempts = 3, label }) {
  let last = { ok: false, summary: 'no attempt ran' };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    console.log(`\n[retry:${label}] attempt ${attempt}/${maxAttempts}`);
    try {
      last = await attemptFn(attempt);
    } catch (e) {
      last = { ok: false, summary: `threw: ${e?.message ?? String(e)}`, retryable: true };
    }
    if (last.ok) {
      console.log(`[retry:${label}] attempt ${attempt} PASS — ${last.summary}`);
      return last;
    }
    if (last.retryable !== true) {
      console.log(`[retry:${label}] attempt ${attempt} FAIL — ${last.summary} (not retryable)`);
      return last;
    }
    console.log(
      `[retry:${label}] attempt ${attempt} FAIL — ${last.summary}` +
        (attempt < maxAttempts ? ' → retrying with a fresh browser' : ''),
    );
  }
  console.log(`[retry:${label}] all ${maxAttempts} attempts failed`);
  return last;
}

export async function evaluateWithDeadline(page, pageFunction, arg, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      page.evaluate(pageFunction, arg),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function closeBrowserWithDeadline(
  browser,
  timeoutMs = 10000,
  label = 'WebKit browser close',
) {
  let timer;
  try {
    await Promise.race([
      browser.close(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    console.error(`[webkit] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

// Fatal WebKit-wasm crash signatures, shared by both probes for log diagnosis
// (NOT the gate — each probe keeps its own pass criteria). Presence of any of
// these in a probe's console log identifies a wasm cold-start crash vs a clean
// gate failure.
export const WASM_CRASH_SIGNATURES = [
  'panicked at',
  'Unreachable code',
  'Out of bounds memory access',
  "can't be introduced",
  'Parking not supported',
];

/**
 * @param {{ text: string }[]} logs
 * @returns {string | null} the first matched crash signature, or null
 */
export function detectWasmCrash(logs) {
  for (const l of logs) {
    for (const sig of WASM_CRASH_SIGNATURES) {
      if (l.text.includes(sig)) return sig;
    }
  }
  return null;
}

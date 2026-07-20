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
// The gate is "retry until pass, or N attempts" — each attempt uses a FRESH
// browser (the crash is a per-process wasm memory fault; a new process recovers).
// This does NOT mask deterministic regressions: a real bug fails every attempt
// and still FAILs after N tries; only a flaky crash can pass on a later attempt.

/**
 * @typedef {{ ok: boolean, summary: string }} AttemptResult
 */

/**
 * Run attemptFn up to maxAttempts times. Returns the first ok result, or the
 * last result if all attempts fail. attemptFn owns its own resources (browser
 * launch/close) so each attempt is fully isolated.
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
      last = { ok: false, summary: `threw: ${e?.message ?? String(e)}` };
    }
    if (last.ok) {
      console.log(`[retry:${label}] attempt ${attempt} PASS — ${last.summary}`);
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

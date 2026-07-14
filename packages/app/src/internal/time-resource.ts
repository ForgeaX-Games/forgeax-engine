// @forgeax/engine-app -- 'Time' Resource shape SSOT (M2 / w5).
//
// The frame-loop writes one record into world.insertResource('Time', {...})
// per rAF tick, BEFORE world.update() runs. This guarantees every system
// that reads `world.getResource('Time')` observes the same dt value
// during a given frame (architecture principle #1 SSOT: dt has exactly
// one carrier, this resource).
//
// Schema: `dt` (clamped delta seconds this frame) + `elapsed` (accumulated
// clamped seconds since the loop started). `elapsed` was added in solo round
// 20260713-212920 (the widening this file's original comment anticipated) to
// map Bevy `Time::elapsed_secs()` — absolute-time-keyed behavior (pulsing,
// sin(elapsed) oscillation, an animation clock) reads `elapsed` instead of
// hand-accumulating `dt` per system (which drifts + re-derives the same fact).
//
// `elapsed` is exactly Σ(clamped dt): it uses the SAME clamped delta as `dt`,
// so a backgrounded tab that produces a large raw gap advances `elapsed` by the
// clamped amount only — no time jump (consistent with the `dt` clamp's purpose).
//
// Architecture principle #4 schema-as-contract: this interface is the reference
// shape consumed by every system that reads 'Time'. Future feats that widen the
// resource (e.g. fixed-step accumulator) MUST add fields here and update the
// call site in frame-loop.ts; no shadow Resource keys (principle #1 SSOT).
export const TIME_RESOURCE_KEY = 'Time' as const;

export interface TimeResource {
  /** Clamped delta seconds for the current frame (>= 0, <= maxDt ceiling). */
  readonly dt: number;
  /** Accumulated clamped seconds since the loop started (Σ dt); starts at the first frame's dt, monotonic non-decreasing. Maps Bevy `Time::elapsed_secs()`. */
  readonly elapsed: number;
}

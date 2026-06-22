// @forgeax/engine-app -- 'Time' Resource shape SSOT (M2 / w5).
//
// The frame-loop writes one record into world.insertResource('Time', {...})
// per rAF tick, BEFORE world.update() runs. This guarantees every system
// that reads `world.getResource('Time')` observes the same dt value
// during a given frame (architecture principle #1 SSOT: dt has exactly
// one carrier, this resource).
//
// Schema: a single field `dt: number` (seconds, finite, non-negative).
// Plan-strategy D-8 deliberately omits fixedDt / accumulated / elapsed
// for the M2 MVP -- those are derivable inside consumer systems if
// needed, and the Resource stays a single source for the clamped delta.
//
// Architecture principle #4 schema-as-contract: this interface is the
// reference shape consumed by every system that reads 'Time'. Future
// feats that widen the resource (e.g. fixed-step accumulator) MUST add
// optional fields here and update the call site in frame-loop.ts; no
// shadow Resource keys.
export const TIME_RESOURCE_KEY = 'Time' as const;

export interface TimeResource {
  /** Clamped delta seconds for the current frame (>= 0, <= maxDt ceiling). */
  readonly dt: number;
}

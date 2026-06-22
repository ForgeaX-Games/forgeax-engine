// @forgeax/engine-app -- numeric constants SSOT (M2 / w4).
//
// MAX_DT_DEFAULT is the dt clamp ceiling applied by the rAF main loop
// when the host does not pass `opts.maxDt`. The numeric value 1/30 s
// (33.333 ms) is locked by plan-strategy D-1 with the following research
// section 6.6 evidence matrix:
//
//   - 30 fps panic threshold: any frame slower than 33.3 ms is already
//     a perceived stutter -- the dt clamp must NOT mask further drift.
//   - ProMotion 24 Hz lower-bound cutoff: iOS variable refresh rate
//     reaches as low as ~24 Hz on still scenes; 1/30 s sits above that
//     so a quiescent device does not get its dt frozen at the ceiling.
//   - Babylon lockstep 1 s upper-bound: Babylon's reference engine clamps
//     at 1 s; that guards against multi-second hangs but is too coarse
//     for our use case (camera spin + physics step) -- 1/30 s is the
//     mid-band choice that protects integrators (D-1 pivot rationale).
//   - 1/60 s (16.67 ms) floor risk: clamping at the typical frame budget
//     turns every late frame into the same observable dt and silently
//     drops physics steps at sustained 30..60 fps -- ruled out (charter
//     P3 explicit failure: prefer the larger ceiling that preserves the
//     drift signal over the tighter ceiling that hides it).
//
// Architecture principle #1 SSOT: every dt-clamp call site reads this
// constant by name (no inline `1 / 30`); the literal value lives once.
//
// Architecture principle #2 derive-don't-duplicate: AppOptions.maxDt
// override flows through createApp -> createFrameLoop and falls back to
// MAX_DT_DEFAULT inside the rAF callback only when omitted -- no second
// "default" hard-coded along the chain.
export const MAX_DT_DEFAULT: number = 1 / 30;

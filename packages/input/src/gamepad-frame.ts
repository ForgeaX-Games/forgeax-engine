// gamepad-frame.ts -- pure functions for per-frame gamepad diff from raw
// navigator.getGamepads() output. No DOM dependency; only called by
// browser-backend.ts @internal.
//
// D-1: edge diff (justPressed / justReleased) derived via set-delta from
// prev vs cur pressed sets — same pattern as Bevy button_input.rs.
// D-1: slot diff (connect / disconnect) derived via set difference from
// prev vs cur slot index sets.
// OOS-4: no deadzone applied — axes pass through raw.

import type { GamepadSlotSample } from './input-snapshot';

/** Minimal raw Gamepad shape from browser API (no DOM types here). */
export interface RawGamepadStub {
  readonly index: number;
  readonly connected: boolean;
  readonly mapping: string;
  readonly buttons: readonly { readonly value: number; readonly pressed: boolean }[];
  readonly axes: readonly number[];
}

/**
 * Standard layout button count (17: 0-16) and axis count (4: 0-3).
 * Non-standard gamepads report standardMapping=false and are fully
 * excluded from diffGamepadFrame (caller filters them out first).
 */
const STANDARD_BUTTON_COUNT = 17;

/**
 * Diff prev vs cur frames for all gamepad slots. Returns a flat
 * GamepadSlotSample[] array keyed by gamepad.index.
 *
 * - connected slots produce GamepadSlotSample with edge sets filled from
 *   prev vs cur pressed-set delta.
 * - disconnected slots (in prev but not in cur) produce
 *   GamepadSlotSample with connected=false and all readpoints empty.
 * - Null entries in the browser getGamepads() array are skipped by the
 *   caller before calling this function.
 * - Non-standard mappings (mapping !== 'standard') produce
 *   GamepadSlotSample with standardMapping=false and all readpoints
 *   empty — connected=true to avoid impersonating disconnected (AC-04).
 */
export function diffGamepadFrame(
  prev: ReadonlyMap<number, GamepadSlotSample>,
  curGamepads: readonly RawGamepadStub[],
): GamepadSlotSample[] {
  const results: GamepadSlotSample[] = [];
  const prevIndices = new Set(prev.keys());
  const curIndices = new Set<number>();

  for (const gp of curGamepads) {
    curIndices.add(gp.index);

    // AC-04: non-standard mapping — connected + standardMapping=false
    // + empty readpoints. Never impersonates disconnected.
    if (gp.mapping !== 'standard') {
      results.push({
        index: gp.index,
        standardMapping: false,
        pressed: new Set(),
        justPressed: new Set(),
        justReleased: new Set(),
        buttonValues: new Map(),
        axes: [0, 0, 0, 0],
      });
      continue;
    }

    const prevSlot = prev.get(gp.index);
    const prevPressed = prevSlot?.pressed ?? new Set<number>();

    // Build current pressed set and buttonValues map from raw Gamepad.
    const curPressed = new Set<number>();
    const buttonValues = new Map<number, number>();
    const btnCount = Math.min(gp.buttons.length, STANDARD_BUTTON_COUNT);
    for (let b = 0; b < btnCount; b++) {
      const btn = gp.buttons[b];
      if (!btn) continue;
      buttonValues.set(b, btn.value);
      if (btn.pressed) {
        curPressed.add(b);
      }
    }

    // Edge delta: justPressed = cur \ prev, justReleased = prev \ cur.
    // Matches Bevy button_input.rs pattern: set-insert return value
    // encodes edge, repeated presses are no-ops.
    const justPressed = new Set<number>();
    const justReleased = new Set<number>();
    for (const b of curPressed) {
      if (!prevPressed.has(b)) justPressed.add(b);
    }
    for (const b of prevPressed) {
      if (!curPressed.has(b)) justReleased.add(b);
    }

    // Axes: raw values, no deadzone (OOS-4).
    const axes: [number, number, number, number] = [
      gp.axes[0] ?? 0,
      gp.axes[1] ?? 0,
      gp.axes[2] ?? 0,
      gp.axes[3] ?? 0,
    ];

    results.push({
      index: gp.index,
      standardMapping: true,
      pressed: curPressed,
      justPressed,
      justReleased,
      buttonValues,
      axes,
    });
  }

  // Disconnected slots: emit empty-signal entries for slots that were in prev
  // but not in cur, so the snapshot reader reports connected=false.
  for (const idx of prevIndices) {
    if (!curIndices.has(idx)) {
      results.push({
        index: idx,
        standardMapping: false,
        pressed: new Set(),
        justPressed: new Set(),
        justReleased: new Set(),
        buttonValues: new Map(),
        axes: [0, 0, 0, 0],
      });
    }
  }

  return results;
}

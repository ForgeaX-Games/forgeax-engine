// gamepad-frame.ts -- pure functions for per-frame gamepad diff from raw
// navigator.getGamepads() output. No DOM dependency; only called by
// browser-backend.ts @internal.
//
// D-1: edge diff (justPressed / justReleased) derived via set-delta from
// prev vs cur pressed sets — same pattern as Bevy button_input.rs.
// D-1: slot diff (connect / disconnect) derived via set difference from
// prev vs cur slot index sets.
// OOS-4: no deadzone applied — axes pass through raw.
//
// M3 D-1 (option A): non-standard-layout gamepads are normalized at the
// acquisition layer. When a caller-supplied remapLookup returns SDL
// gamecontrollerdb.txt mapping tokens for the gamepad's id, raw HID
// button/axis indices are re-projected onto the standard layout and the
// slot is reported with standardMapping=true. No lookup / no match keeps
// the Feat1 empty-signal behaviour (graceful degradation).

import type { MappingTokens } from './controller-db';
import type { GamepadSlotSample } from './input-snapshot';

/**
 * Minimal raw Gamepad shape from browser API (no DOM types here).
 *
 * M3 F-2 seam fix: `id` mirrors the browser `Gamepad.id` string so the
 * remap lookup can derive the SDL GUID keyed by device identity (not by
 * slot index, which is unstable across reconnects).
 */
export interface RawGamepadStub {
  readonly index: number;
  readonly id: string;
  readonly connected: boolean;
  readonly mapping: string;
  readonly buttons: readonly { readonly value: number; readonly pressed: boolean }[];
  readonly axes: readonly number[];
}

/**
 * Standard layout button count (17: 0-16) and axis count (4: 0-3).
 * Non-standard gamepads without a DB match report standardMapping=false
 * and empty readpoints.
 */
const STANDARD_BUTTON_COUNT = 17;

/**
 * SDL logical name -> standard-layout button index (W3C Gamepad standard
 * mapping, KB source section 4.3). `guide` occupies the optional 17th slot.
 */
const STANDARD_BUTTON_INDEX: Readonly<Record<string, number>> = {
  a: 0,
  b: 1,
  x: 2,
  y: 3,
  leftshoulder: 4,
  rightshoulder: 5,
  lefttrigger: 6,
  righttrigger: 7,
  back: 8,
  start: 9,
  leftstick: 10,
  rightstick: 11,
  dpup: 12,
  dpdown: 13,
  dpleft: 14,
  dpright: 15,
  guide: 16,
};

/** SDL logical name -> standard-layout axis index (KB source section 4.3). */
const STANDARD_AXIS_INDEX: Readonly<Record<string, number>> = {
  leftx: 0,
  lefty: 1,
  rightx: 2,
  righty: 3,
};

/** Analog trigger threshold: a trigger mapped to an axis counts as pressed above this. */
const TRIGGER_PRESS_THRESHOLD = 0.5;

interface RemappedReadpoints {
  readonly pressed: Set<number>;
  readonly buttonValues: Map<number, number>;
  readonly axes: [number, number, number, number];
}

/**
 * Re-project a non-standard raw gamepad onto the standard layout using SDL
 * mapping tokens. Browser getGamepads() exposes only buttons[] and axes[]
 * (no hats), so hat tokens (dpad-as-hat) cannot be resolved from raw data
 * and are skipped — a documented graceful degradation for the rare hat-only
 * dpad devices under the web Gamepad API.
 */
function remapToStandardLayout(gp: RawGamepadStub, tokens: MappingTokens): RemappedReadpoints {
  const pressed = new Set<number>();
  const buttonValues = new Map<number, number>();
  const axes: [number, number, number, number] = [0, 0, 0, 0];

  for (const [name, token] of Object.entries(tokens)) {
    const stdButton = STANDARD_BUTTON_INDEX[name];
    const stdAxis = STANDARD_AXIS_INDEX[name];

    if (stdButton !== undefined) {
      if (token.kind === 'button') {
        const raw = gp.buttons[token.index];
        if (raw) {
          buttonValues.set(stdButton, raw.value);
          if (raw.pressed) pressed.add(stdButton);
        }
      } else if (token.kind === 'axis') {
        // Trigger (or button) mapped to a raw axis: value = raw axis reading.
        const value = gp.axes[token.index] ?? 0;
        buttonValues.set(stdButton, value);
        if (value > TRIGGER_PRESS_THRESHOLD) pressed.add(stdButton);
      }
      // hat -> button (dpad): no hat source in the browser API; skip.
      continue;
    }

    if (stdAxis !== undefined && token.kind === 'axis') {
      const raw = gp.axes[token.index] ?? 0;
      axes[stdAxis] = token.half === '-' ? -raw : raw;
    }
  }

  return { pressed, buttonValues, axes };
}

/** Build an empty-signal slot sample (non-standard-no-match / disconnected). */
function emptySlot(index: number): GamepadSlotSample {
  return {
    index,
    standardMapping: false,
    pressed: new Set(),
    justPressed: new Set(),
    justReleased: new Set(),
    buttonValues: new Map(),
    axes: [0, 0, 0, 0],
  };
}

/** Derive justPressed / justReleased edge sets from prev vs cur pressed sets. */
function edges(
  prevPressed: ReadonlySet<number>,
  curPressed: ReadonlySet<number>,
): { justPressed: Set<number>; justReleased: Set<number> } {
  const justPressed = new Set<number>();
  const justReleased = new Set<number>();
  for (const b of curPressed) {
    if (!prevPressed.has(b)) justPressed.add(b);
  }
  for (const b of prevPressed) {
    if (!curPressed.has(b)) justReleased.add(b);
  }
  return { justPressed, justReleased };
}

/**
 * Diff prev vs cur frames for all gamepad slots. Returns a flat
 * GamepadSlotSample[] array keyed by gamepad.index.
 *
 * - Standard-mapping slots produce GamepadSlotSample with edge sets filled
 *   from prev vs cur pressed-set delta.
 * - Non-standard slots: when `remapLookup` returns mapping tokens for the
 *   gamepad id, raw HID indices are re-projected onto the standard layout
 *   and the slot reports standardMapping=true (D-1 semantic redefinition).
 *   With no lookup or no match, the slot reports standardMapping=false with
 *   empty readpoints and connected=true (Feat1 behaviour, AC-04).
 * - Disconnected slots (in prev but not in cur) produce a slot with
 *   standardMapping=false and all readpoints empty.
 * - Null entries in the browser getGamepads() array are skipped by the
 *   caller before calling this function.
 *
 * @param remapLookup - Optional acquisition-layer normalizer. Given a
 *   browser Gamepad.id, returns SDL mapping tokens or null. Only consulted
 *   for non-standard-mapping gamepads (D-1 option A).
 */
export function diffGamepadFrame(
  prev: ReadonlyMap<number, GamepadSlotSample>,
  curGamepads: readonly RawGamepadStub[],
  remapLookup?: (gamepadId: string) => MappingTokens | null,
): GamepadSlotSample[] {
  const results: GamepadSlotSample[] = [];
  const prevIndices = new Set(prev.keys());
  const curIndices = new Set<number>();

  for (const gp of curGamepads) {
    curIndices.add(gp.index);
    const prevPressed = prev.get(gp.index)?.pressed ?? new Set<number>();
    results.push(
      gp.mapping === 'standard'
        ? diffStandardSlot(gp, prevPressed)
        : diffNonStandardSlot(gp, prevPressed, remapLookup),
    );
  }

  // Disconnected slots: emit empty-signal entries for slots that were in prev
  // but not in cur, so the snapshot reader reports connected=false.
  for (const idx of prevIndices) {
    if (!curIndices.has(idx)) {
      results.push(emptySlot(idx));
    }
  }

  return results;
}

/** Diff a standard-mapping gamepad slot: raw indices pass through 1:1. */
function diffStandardSlot(gp: RawGamepadStub, prevPressed: ReadonlySet<number>): GamepadSlotSample {
  const curPressed = new Set<number>();
  const buttonValues = new Map<number, number>();
  const btnCount = Math.min(gp.buttons.length, STANDARD_BUTTON_COUNT);
  for (let b = 0; b < btnCount; b++) {
    const btn = gp.buttons[b];
    if (!btn) continue;
    buttonValues.set(b, btn.value);
    if (btn.pressed) curPressed.add(b);
  }
  const { justPressed, justReleased } = edges(prevPressed, curPressed);
  // Axes: raw values, no deadzone (OOS-4).
  const axes: [number, number, number, number] = [
    gp.axes[0] ?? 0,
    gp.axes[1] ?? 0,
    gp.axes[2] ?? 0,
    gp.axes[3] ?? 0,
  ];
  return {
    index: gp.index,
    standardMapping: true,
    pressed: curPressed,
    justPressed,
    justReleased,
    buttonValues,
    axes,
  };
}

/**
 * Diff a non-standard-mapping gamepad slot (D-1 option A): attempt an
 * acquisition-layer remap via the SDL DB. No lookup / no match falls back
 * to the Feat1 empty signal with connected=true (AC-04).
 */
function diffNonStandardSlot(
  gp: RawGamepadStub,
  prevPressed: ReadonlySet<number>,
  remapLookup?: (gamepadId: string) => MappingTokens | null,
): GamepadSlotSample {
  const tokens = remapLookup ? remapLookup(gp.id) : null;
  if (!tokens) return emptySlot(gp.index);
  const { pressed, buttonValues, axes } = remapToStandardLayout(gp, tokens);
  const { justPressed, justReleased } = edges(prevPressed, pressed);
  return {
    index: gp.index,
    standardMapping: true,
    pressed,
    justPressed,
    justReleased,
    buttonValues,
    axes,
  };
}

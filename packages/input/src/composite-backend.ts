// @forgeax/engine-input -- CompositeInputBackend (synthetic-input decorator).
//
// PROBLEM. The scan system reads ONE `InputBackend` from `INPUT_BACKEND_KEY`
// each frame. An AI / record-replay harness needs to feed synthetic input into
// that same slot WITHOUT evicting the human's browser backend -- because a human
// may take over at any instant (PIE two-world model + charter §8 human-as-final-
// authority). Overwriting the resource locks the human out; wrapping it does not.
//
// SOLUTION. `makeCompositeBackend(inner)` returns an `InputBackend` that HOLDS
// the human backend as `inner` and layers a programmatic injection surface
// (`press` / `release` / `setButton` / `addMovement` / `addWheel`) on top. The
// scan system stays variant-agnostic: it still calls `sample()` on one backend
// (Depend-on-Abstractions -- the consumer never learns a composite exists).
//
// SIDE-EFFECT CONTRACT. `inner.sample()` DRAINS its per-frame accumulators
// (up-edges, movement delta, wheel notches) on read, so the composite calls it
// EXACTLY ONCE per `sample()` and drains its OWN injected accumulators in the
// same pass. Field-by-field merge honoring each field's lifecycle:
//
//   downKeys   held across frames    -> UNION(inner, injected.held)
//   upKeys     lives one frame        -> UNION; injected up-edge set drained here
//   buttons    held tuple             -> OR per slot
//   movementX/Y, wheelDelta            -> SUM; injected side reset to 0 here
//   focused    gates up-edge suppress -> inner.focused || injectionActive
//   pointerLocked                      -> inner (AI must not fabricate a lock)
//   optional (pointers/gamepads/...)   -> pass through from inner untouched
//
// YIELD-TO-HUMAN (default on). A human-held key on `inner` suppresses only the
// injected state for that SAME key in that frame. Other AI keys continue, so a
// human can take a key without silencing unrelated synthetic input. This is the
// structural realization of "human wins" without a global takeover policy.

import type { InputBackend, InputBackendSample } from './input-snapshot';

/** Options controlling the composite merge policy. */
export interface CompositeBackendOptions {
  /**
   * When `true` (default), a key held on the inner (human) backend suppresses
   * injected state only for that same key in that frame. Set `false` for
   * record/replay or AI-solo scenarios where both sources should coexist even
   * on key overlap.
   */
  readonly yieldToHuman?: boolean;
}

/**
 * A composite backend: an `InputBackend` (drop-in for `INPUT_BACKEND_KEY`) plus
 * a programmatic injection surface. All injection is additive over the wrapped
 * human backend.
 */
export interface CompositeInputBackend extends InputBackend {
  /** Hold `key` down (mirrors a keydown). Idempotent. */
  press(key: string): void;
  /** Release `key` (mirrors a keyup); emits a one-frame up-edge on next sample. */
  release(key: string): void;
  /** Set an injected mouse-button slot (0/1/2) held-state. */
  setButton(slot: 0 | 1 | 2, down: boolean): void;
  /** Accumulate injected pointer-lock movement delta (drained on next sample). */
  addMovement(dx: number, dy: number): void;
  /** Accumulate injected wheel notches (drained on next sample). */
  addWheel(notches: number): void;
  /** Drop all injected state; currently-held keys emit a clean up-edge once. */
  clearInjected(): void;
  /** Toggle the yield-to-human gate at runtime. */
  setYieldToHuman(yield_: boolean): void;
}

export function makeCompositeBackend(
  inner: InputBackend,
  options?: CompositeBackendOptions,
): CompositeInputBackend {
  let yieldToHuman = options?.yieldToHuman ?? true;

  // Injected held-state (survives across frames).
  const heldKeys = new Set<string>();
  const buttons: [boolean, boolean, boolean] = [false, false, false];
  // Injected per-frame accumulators (drained on each sample()).
  const upEdges = new Set<string>();
  let mvx = 0;
  let mvy = 0;
  let wheel = 0;

  function injectionActive(): boolean {
    return heldKeys.size > 0 || upEdges.size > 0 || buttons.some((b) => b);
  }

  function sample(): InputBackendSample {
    // Call inner EXACTLY once -- it drains its own accumulators here.
    const base = inner.sample();

    // yield-to-human is PER-KEY: an injected key is suppressed only when the human
    // is holding the SAME key this frame. This is the minimal realization of
    // charter §8 (the human always wins a key they touch) WITHOUT the collateral of
    // a global gate — a human strafing D does not silence an AI holding W, so the
    // two genuinely coexist (that is the whole point of a composite; a caller who
    // wants "human takes over everything" can clearInjected() at the policy layer).
    // downKeys: union of human-held and injected-held, minus injected keys the human
    // is also pressing. A yielded injected release is likewise a no-op: emitting its
    // up-edge would incorrectly release the human-held key in the scan system.
    const downKeys = new Set(base.downKeys);
    for (const k of heldKeys) {
      if (yieldToHuman && base.downKeys.has(k)) continue; // human owns this exact key
      downKeys.add(k);
    }

    // upKeys: union of human up-edges and injected up-edges (one-frame life), except
    // injected edges for keys that the human still owns under the per-key yield gate.
    const mergedUp = new Set(base.upKeys);
    for (const k of upEdges) {
      if (yieldToHuman && base.downKeys.has(k)) continue;
      mergedUp.add(k);
    }

    // buttons: OR per slot.
    const mergedButtons: readonly [boolean, boolean, boolean] = [
      base.buttons[0] || buttons[0],
      base.buttons[1] || buttons[1],
      base.buttons[2] || buttons[2],
    ];

    // focused: keep true while WE are injecting, so the scan system does not
    // treat a headless/backgrounded tab (inner.focused === false) as a reason
    // to suppress our up-edges. Otherwise mirror inner.
    const focused = base.focused || injectionActive();

    const out: InputBackendSample = {
      ...base, // carry inner optional fields (pointers/gamepads/gestures/...) untouched
      downKeys,
      upKeys: mergedUp,
      buttons: mergedButtons,
      movementX: base.movementX + mvx,
      movementY: base.movementY + mvy,
      wheelDelta: base.wheelDelta + wheel,
      focused,
      pointerLocked: base.pointerLocked, // AI never fabricates a lock
    };

    // Drain injected per-frame accumulators (mirrors inner's own drain).
    upEdges.clear();
    mvx = 0;
    mvy = 0;
    wheel = 0;

    return out;
  }

  // Only surface setPointerLockAllowed when the inner backend supports it, so
  // the optional method is truly absent (not `undefined`) under
  // exactOptionalPropertyTypes -- and forwards to the human backend when present.
  const lockGate: Pick<InputBackend, 'setPointerLockAllowed'> = inner.setPointerLockAllowed
    ? { setPointerLockAllowed: (allowed: boolean) => inner.setPointerLockAllowed?.(allowed) }
    : {};

  return {
    sample,
    ...lockGate,
    // Teardown belongs to the human backend -- forward it.
    detach: () => inner.detach(),

    press(key) {
      heldKeys.add(key);
      upEdges.delete(key); // re-press cancels a pending release edge
    },
    release(key) {
      if (heldKeys.delete(key)) upEdges.add(key); // held -> emit one up-edge
    },
    setButton(slot, down) {
      buttons[slot] = down;
    },
    addMovement(dx, dy) {
      mvx += dx;
      mvy += dy;
    },
    addWheel(notches) {
      wheel += notches;
    },
    clearInjected() {
      for (const k of heldKeys) upEdges.add(k); // clean release edge for each
      heldKeys.clear();
      buttons[0] = buttons[1] = buttons[2] = false;
      mvx = 0;
      mvy = 0;
      wheel = 0;
    },
    setYieldToHuman(yield_) {
      yieldToHuman = yield_;
    },
  };
}

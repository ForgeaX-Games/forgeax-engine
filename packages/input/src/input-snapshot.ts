// input-snapshot.ts -- frozen frame-start input snapshot Resource (5-method
// surface) for forgeax-engine.
//
// AC-07 / AC-08 + plan-strategy D-5 / D-7 lock the surface to:
//   keyboard.down(key)  -> boolean   (held this frame)
//   keyboard.up(key)    -> boolean   (up-edge that landed in the prior frame)
//   mouse.movementDelta -> { x, y }  (PointerLock movementX/Y accumulator)
//   mouse.button(i)     -> boolean   (W3C MouseEvent.button: 0 / 1 / 2)
//   mouse.wheelDelta    -> number    (sign-discrete notches per frame)
//
// charter awareness:
//   F2 minimal surface -- 4 methods, nothing else
//   P3 explicit failure -- no thrown errors from accessor methods; absent
//     keys / pre-start state report `false` / `0` (the empty signal IS
//     the signal). `mouse.button(i)` parameter is the literal union
//     `0 | 1 | 2`, so an out-of-range index is a TS compile error rather
//     than a runtime bounds-clamp.
//   P4 consistent abstraction -- the snapshot hides the producer
//     (browser PointerLock + key listeners) entirely; consumers read via
//     the `InputSnapshot` Resource regardless of backend
//   P5 producer/consumer split -- the InputBackend protocol decouples
//     the producer from the snapshot; `frame-start-scan-system.ts` is the
//     bridge that calls `backend.sample()` and writes the Resource

/**
 * Frozen value-shape view exposed to user systems via the `InputSnapshot`
 * Resource. The methods are pure reads; calling them does not mutate any
 * accumulator (charter P3 -- no observable side effects from the accessor
 * surface). A fresh `InputSnapshot` instance is constructed by the
 * frame-start scan system once per `world.update()` and replaces the
 * previous Resource value.
 */
export interface InputSnapshot {
  /** Keyboard view (charter F2 minimal surface: down + up only). */
  readonly keyboard: {
    /**
     * `true` while `key` is currently held. `key` matches the value the
     * backend records (KeyboardEvent.key for the browser backend). When
     * the key is not in the held set, returns `false` -- never throws
     * (charter P3: empty signal is the signal).
     */
    down(key: string): boolean;
    /**
     * `true` for one frame after the key was released (the up-edge). The
     * edge collapses on the following `world.update()`. `key` not in the
     * up-edge set returns `false`.
     */
    up(key: string): boolean;
  };
  /** Mouse view (charter F2 minimal surface: movementDelta + button + wheelDelta). */
  readonly mouse: {
    /**
     * PointerLock-style accumulated movement since the previous frame.
     * Value is frozen at frame-start; reading it does not clear the
     * accumulator. The next `world.update()` produces a fresh delta
     * (zero if no movement events arrived).
     */
    readonly movementDelta: { readonly x: number; readonly y: number };
    /**
     * `true` while the W3C MouseEvent.button slot `i` is held. `i` is
     * narrowed to the literal `0 | 1 | 2` so out-of-range indices are
     * rejected at compile time (charter P3 explicit failure: TS literal
     * narrowing replaces a runtime bounds-clamp).
     *
     * - 0 -- primary button (left)
     * - 1 -- auxiliary button (middle)
     * - 2 -- secondary button (right)
     */
    button(i: 0 | 1 | 2): boolean;
    /**
     * Discrete wheel notches accumulated since the previous frame.
     * Plan-strategy D-5 sign-discrete: each `WheelEvent` contributes
     * `Math.sign(event.deltaY)` to the per-frame accumulator regardless
     * of `deltaMode` (PIXEL / LINE / PAGE all collapse). Sign convention
     * follows W3C `WheelEvent.deltaY`: positive = scroll down / away
     * from user, negative = scroll up / toward user.
     *
     * Value is frozen at frame-start; reading it does not clear the
     * accumulator. The next `world.update()` produces a fresh delta
     * (zero when no wheel events arrived).
     *
     * Trade-off (plan-strategy R-7): trackpad high-resolution wheel
     * events collapse to one notch per event, losing sub-notch fidelity.
     * AI users who need analog magnitude must opt in via a future
     * unitful surface (OOS-7 ScrollSnapshot is the deferred shape).
     */
    readonly wheelDelta: number;
  };
}

/**
 * Backend protocol consumed by the frame-start scan system. The browser
 * implementation (`browser-backend.ts`) is the production producer;
 * tests inject fakes that emit synthetic samples.
 */
export interface InputBackend {
  /**
   * Produce one frame's worth of input data and reset the per-frame
   * accumulators (movement delta + up-edge set). Held-key state and
   * held-button state survive across calls.
   *
   * Contract notes:
   * - `downKeys` is the held-key set as of the call (held across frames)
   * - `upKeys` is the up-edge set since the previous sample (cleared
   *   after the call so the edge appears in exactly one frame)
   * - `buttons` is the held-button slot tuple `[b0, b1, b2]`
   * - `movementX` / `movementY` are the accumulated PointerLock delta
   *   since the previous sample (cleared after the call)
   * - `focused` mirrors `document.hasFocus()` so the scan system can
   *   suppress spurious up-edges across alt-tab transitions
   */
  sample(): InputBackendSample;
  /** Detach DOM listeners; called when the engine shuts down. */
  detach(): void;
}

/** Snapshot value returned by `InputBackend.sample()` (POD). */
export interface InputBackendSample {
  readonly downKeys: ReadonlySet<string>;
  readonly upKeys: ReadonlySet<string>;
  readonly buttons: readonly [boolean, boolean, boolean];
  readonly movementX: number;
  readonly movementY: number;
  /**
   * Sign-discrete wheel notch accumulator since the previous sample
   * (plan-strategy D-5). Browser backend writes `Math.sign(deltaY)` per
   * `WheelEvent`; sample() drains the value and resets the producer
   * accumulator (mirrors movementX/Y semantics).
   */
  readonly wheelDelta: number;
  readonly focused: boolean;
}

/**
 * Build an `InputSnapshot` from a backend sample. The returned object is
 * frozen on construction: `down/up/button` are bound to the closed-over
 * sets, and `movementDelta` is a frozen literal. Subsequent backend
 * activity does not bleed into the snapshot.
 */
export function snapshotFromSample(sample: InputBackendSample): InputSnapshot {
  // structuralCopy: copying into local sets isolates the snapshot from
  // any later backend mutation (the browser backend reuses its internal
  // Set across frames). architecture-principles #2 derive: a Snapshot is
  // a derived view of the producer's state at one instant.
  const heldKeys = new Set<string>(sample.downKeys);
  const upEdges = new Set<string>(sample.upKeys);
  const buttons: readonly [boolean, boolean, boolean] = [
    sample.buttons[0],
    sample.buttons[1],
    sample.buttons[2],
  ];
  const movementDelta = Object.freeze({ x: sample.movementX, y: sample.movementY });
  const wheelDelta = sample.wheelDelta;
  const snapshot: InputSnapshot = {
    keyboard: {
      down(key) {
        return heldKeys.has(key);
      },
      up(key) {
        return upEdges.has(key);
      },
    },
    mouse: {
      movementDelta,
      button(i) {
        // i is narrowed to 0 | 1 | 2 by the type system; the runtime
        // index is therefore guaranteed to land in `buttons` (charter P3
        // -- no defensive fallback necessary because the type narrows the
        // input domain to the legal slots).
        return buttons[i] === true;
      },
      wheelDelta,
    },
  };
  return Object.freeze(snapshot);
}

/**
 * Construct an empty snapshot for the pre-start window
 * (`engine.run()` has not yet attached a backend). Returns the same
 * 4-method shape as `snapshotFromSample`, with every accessor returning
 * `false` / `{ x: 0, y: 0 }`. AI users can put this into the Resource
 * store to satisfy `world.getResource('InputSnapshot')` calls in
 * fixtures or unit tests (charter P3: empty signal is the signal).
 */
export function createInputSnapshot(): InputSnapshot {
  return snapshotFromSample({
    downKeys: new Set<string>(),
    upKeys: new Set<string>(),
    buttons: [false, false, false],
    movementX: 0,
    movementY: 0,
    wheelDelta: 0,
    focused: true,
  });
}

/** Stable Resource key for `world.insertResource` / `world.getResource`. */
export const INPUT_SNAPSHOT_RESOURCE_KEY = 'InputSnapshot';

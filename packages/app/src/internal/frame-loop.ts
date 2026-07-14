// @forgeax/engine-app -- rAF closure + 4-state machine + dt clamp (M2 / w5).
//
// Public surface (consumed only by createApp -- this module lives under
// `internal/` and is not re-exported from the package barrel):
//
//   const handle = createFrameLoop({ world, renderer, maxDt?, onError?, ... });
//   handle.start();   // idle -> running
//   handle.pause();   // running -> paused | paused -> paused (idempotent)
//   handle.resume();  // paused -> running
//   handle.stop();    // running -> idle
//
// State machine (4 states; 9 declared transitions, plus 'stopped' terminal
// reserved for M4 device-lost ingress through setStopped):
//
//   idle    -- start()  --> running
//   running -- start()  --> err 'app-already-running'  (state preserved)
//   running -- pause()  --> paused
//   paused  -- pause()  --> paused                     (idempotent ok)
//   paused  -- resume() --> running
//   running -- stop()   --> idle
//   paused  -- stop()   --> err 'app-paused-while-stop' (state preserved)
//   idle    -- stop()   --> err 'app-not-started'     (state preserved)
//   idle    -- resume() --> err 'app-not-started'     (state preserved)
//   stopped -- start()  --> err 'app-not-started'     (M4 device-lost gate)
//
// Frame budget order (user callbacks between steps 3 and 4, plan-strategy D-1):
//
//   1. now() -> rawDt = (t - lastT) / 1000
//   2. dt = clamp(rawDt, 0, maxDt ?? MAX_DT_DEFAULT)
//   3. world.insertResource('Time', { dt })
//   3.5. registered user update callbacks (try-catch, per-callback fan-out)
//   4. world.update()
//   5. renderer.draw(world)
//   6. raf(tick)  // schedule next frame
//
// Charter awareness:
//   - P3 explicit failure: every API returns Result<void, AppError>
//   - P4 consistent abstraction: start / stop / pause / resume share
//     the same return type and error union -- no asymmetric exceptions

import { err, ok, type Result, type World } from '@forgeax/engine-ecs';
import type { RhiError } from '@forgeax/engine-rhi/errors';
import type { Renderer } from '@forgeax/engine-runtime';

import { MAX_DT_DEFAULT } from '../constants';
import type { AppErrorCode, AppErrorDetailFor } from '../errors';
import { AppError } from '../errors';
import { TIME_RESOURCE_KEY, type TimeResource } from './time-resource';

export type FrameState = 'idle' | 'running' | 'paused' | 'stopped';

/** Per-frame update callback signature: receives clamped dt in seconds. */
export type UpdateCallback = (dt: number) => void;

/**
 * Injection seams for testing + portability:
 *   - now: time source (defaults to performance.now via globalThis).
 *   - raf: frame scheduler (defaults to globalThis.requestAnimationFrame).
 *   - caf: frame canceller (defaults to globalThis.cancelAnimationFrame).
 *
 * The defaults assume a browser-like host; node hosts must inject all
 * three explicitly (M4 wires the browser defaults; node integration
 * tests cover the injection path through this module directly).
 */
export interface FrameLoopOptions {
  readonly world: World;
  readonly renderer: Renderer;
  readonly maxDt?: number;
  readonly onError?: (e: AppError | RhiError) => void;
  readonly now?: () => number;
  readonly raf?: (cb: (t: number) => void) => number;
  readonly caf?: (id: number) => void;
  /**
   * feat-20260709-editor-world-partition-editorworld-super-composite / M2 / D-3:
   * optional per-frame draw-source pull. When omitted (or when it returns
   * undefined at tick time), the loop renders its own single `world` via
   * `renderer.draw([world], { owner: 0 })` (legacy path). When it returns a
   * result, the loop updates EVERY returned world (transform propagation)
   * before `renderer.draw(worlds, { cameraOwner, resourceOwner })`. w11 threads
   * the field; w12 consumes it in tick().
   */
  readonly drawSource?: () =>
    | { worlds: readonly World[]; cameraOwner: number; resourceOwner: number }
    | undefined;
}

export interface FrameLoopHandle {
  start(): Result<void, AppError>;
  stop(): Result<void, AppError>;
  pause(): Result<void, AppError>;
  resume(): Result<void, AppError>;
  getState(): FrameState;
  /**
   * Internal hook reserved for M4 device-lost path. Forces the state
   * machine into 'stopped'; subsequent start() returns 'app-not-started'.
   * Public types do not expose this -- only createApp internals call it.
   */
  setStopped(): void;
  /**
   * Register a per-frame update callback. The callback receives dt (the
   * clamped delta-time in seconds) and executes between Time resource
   * injection and world.update() every frame while the frame-loop is
   * running (plan-strategy D-1). Exceptions are wrapped as AppError
   * ({code:'app-system-update-failed', detail:{cause}}) and dispatched
   * via opts.onError; the callback is NOT unregistered after a throw
   * (keep-callback semantics, requirements boundary-case table).
   */
  addUpdateCallback(fn: UpdateCallback): void;
}

function makeAppError<C extends AppErrorCode>(
  code: C,
  expected: string,
  hint: string,
  detail: AppErrorDetailFor<C>,
): AppError {
  return new AppError({ code, expected, hint, detail }) as AppError;
}

function makeWorldUpdateError(cause: unknown): AppError {
  // Wrap a synchronous world.update failure (host system throw or
  // renderer.draw throw) into the closed AppError union member
  // 'app-system-update-failed'. cause is preserved verbatim so AI
  // users can two-level narrow (e.g. `instanceof EcsError`) without
  // losing structure (plan-strategy D-4).
  return makeAppError(
    'app-system-update-failed',
    'world.update() and renderer.draw(world) complete synchronously',
    'check detail.cause for the original thrown value (EcsError, host system bug, RhiError, ...)',
    { cause },
  );
}

/**
 * feat-20260709-editor-world-partition-editorworld-super-composite M2 / D-3:
 * run world.update() on every draw-source-injected world so its derived
 * Transform.world mat4 is freshly propagated before the renderer's extract stage
 * reads it (no stale matrix; w9 pins this). `ownWorld` is skipped — the tick has
 * already updated it, and a drawSource that (degenerately) lists the own world
 * must not trigger a second update. A per-world update throw is a host system
 * bug: surfaced via `fireError` without aborting the remaining worlds (charter
 * P3 explicit failure + proposition 9 graceful degradation).
 *
 * Extracted from tick() so the per-frame draw path reads as three linear steps
 * (own update -> injected updates -> draw) rather than a nested loop inline.
 */
function updateInjectedWorlds(
  worlds: readonly World[],
  ownWorld: World,
  fireError: ((e: AppError | RhiError) => void) | undefined,
): void {
  for (let i = 0; i < worlds.length; i++) {
    const injectedWorld = worlds[i];
    if (injectedWorld === undefined || injectedWorld === ownWorld) {
      continue;
    }
    try {
      injectedWorld.update();
    } catch (e: unknown) {
      if (fireError !== undefined) {
        fireError(makeWorldUpdateError(e));
      }
    }
  }
}

function resolveNow(opts: FrameLoopOptions): () => number {
  if (opts.now !== undefined) {
    return opts.now;
  }
  // Dynamic lookup: read globalThis.performance.now() on every tick instead
  // of capturing a reference at construction time. This lets tests and host
  // environments replace performance.now after createFrameLoop (e.g. for
  // deterministic replay) and have the new time source take effect
  // immediately. Without this, a synchronous tight-loop of 300 frames may
  // land on the same millisecond and produce dt=0, freezing tick systems
  // that gate on non-zero delta-time (e.g. physics). The per-tick property
  // read overhead is negligible vs a GPU frame.
  return () => {
    const perf = (globalThis as { performance?: { now?: () => number } }).performance;
    const fn = perf?.now;
    return typeof fn === 'function' ? fn.call(perf) : Date.now();
  };
}

function resolveRaf(opts: FrameLoopOptions): (cb: (t: number) => void) => number {
  if (opts.raf !== undefined) {
    return opts.raf;
  }
  const g = globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number };
  if (typeof g.requestAnimationFrame === 'function') {
    return g.requestAnimationFrame.bind(globalThis);
  }
  // Node host without injection: surface a synthetic id. The frame-loop
  // never schedules subsequent frames in that case (start()'s own check
  // catches this earlier in M4); guard here is paranoid.
  return () => 0;
}

function resolveCaf(opts: FrameLoopOptions): (id: number) => void {
  if (opts.caf !== undefined) {
    return opts.caf;
  }
  const g = globalThis as { cancelAnimationFrame?: (id: number) => void };
  if (typeof g.cancelAnimationFrame === 'function') {
    return g.cancelAnimationFrame.bind(globalThis);
  }
  return () => {
    // no-op
  };
}

export function createFrameLoop(opts: FrameLoopOptions): FrameLoopHandle {
  const { world, renderer } = opts;
  const ceiling = opts.maxDt ?? MAX_DT_DEFAULT;
  const now = resolveNow(opts);
  const raf = resolveRaf(opts);
  const caf = resolveCaf(opts);

  let state: FrameState = 'idle';
  let lastTimestamp = 0;
  // Accumulated clamped seconds since the loop started (Σ dt), projected onto the
  // Time resource's `elapsed` field. Accumulated only inside tick() (which returns
  // early when not running), so pause() naturally freezes it and resume() continues
  // — matching Bevy's Time::elapsed. Never reset on resume; a fresh loop starts at 0.
  let elapsed = 0;
  let pendingFrameId = 0;
  const updateCallbacks: UpdateCallback[] = [];

  function tick(): void {
    if (state !== 'running') {
      return;
    }
    const t = now();
    const rawDtSeconds = (t - lastTimestamp) / 1000;
    lastTimestamp = t;
    const dt = Math.min(Math.max(rawDtSeconds, 0), ceiling);
    elapsed += dt;
    const time: TimeResource = { dt, elapsed };
    world.insertResource(TIME_RESOURCE_KEY, time);

    // Execute user-registered update callbacks before world.update() so
    // user mutations to ECS state (component data, resources) are visible
    // to ECS systems in the same frame (plan-strategy D-1). Each callback
    // runs in its own try-catch; throw wraps as AppError + fans out via
    // opts.onError without removing the callback (keep-callback semantics,
    // requirements boundary-case table).
    if (updateCallbacks.length > 0) {
      const fireError = opts.onError;
      for (let i = 0; i < updateCallbacks.length; i++) {
        try {
          updateCallbacks[i]?.(dt);
        } catch (e: unknown) {
          if (fireError !== undefined) {
            fireError(makeWorldUpdateError(e));
          }
        }
      }
    }

    // Frame budget order: world.update() -> renderer.draw(world).
    //
    // M4 (w11) wraps the two failure paths so the rAF closure does NOT
    // unwind on host system bugs; both errors fan out via opts.onError
    // and the frame loop continues scheduling so a transient failure
    // does not freeze the engine on a single bad frame.
    //
    //   - world.update synchronous throw -> wrap into AppError
    //     ({code:'app-system-update-failed', detail:{cause}}); plan-
    //     strategy D-4 + AC-04. The cause field preserves the original
    //     thrown value (often EcsError or host-system Error) so AI
    //     users can do `if (err.detail.cause instanceof EcsError) ...`
    //     two-level narrow without losing structure.
    //   - renderer.draw returning Result.err(rhiErr) -> rhiErr is
    //     forwarded verbatim (no re-wrap); AC-04 + plan-strategy D-9.
    //
    // Both paths skip the next rAF schedule of the same call site only
    // by throwing; the catch arm always re-arms raf(tick) below so the
    // host can recover (charter P3 explicit failure: errors are loud
    // signals, not termination conditions).
    const fireError = opts.onError;
    try {
      world.update();
    } catch (e: unknown) {
      if (fireError !== undefined) {
        fireError(makeWorldUpdateError(e));
      }
    }

    // feat-20260709-editor-world-partition-editorworld-super-composite M2 / D-3:
    // pull the optional per-frame draw-source AFTER the own world's update. The
    // pull decides whether this frame stays on the single-world path or switches
    // to the injected multi-world path.
    //
    //   - drawSource absent, OR present but returning undefined -> single-world
    //     path, byte-identical to the legacy draw([world], { owner: 0 }).
    //   - drawSource returns a result -> the frame-loop MUST world.update() every
    //     returned world (skipping the own world, already updated above, so it is
    //     never double-updated) BEFORE draw. This is load-bearing: the renderer's
    //     extract stage reads the DERIVED Transform.world mat4, whose sole writer
    //     is the propagateTransforms system that only runs inside world.update().
    //     Feeding an un-updated injected world to draw would render a stale (or
    //     first-frame identity) matrix (Strategist D-3; w9 pins this contract).
    //
    // A throwing draw-source is a host bug: surface it via fan-out and fall back
    // to the single-world path so the frame still renders (charter P3 explicit
    // failure -- a bad seam callback must not freeze the loop).
    let injected:
      | { worlds: readonly World[]; cameraOwner: number; resourceOwner: number }
      | undefined;
    if (opts.drawSource !== undefined) {
      try {
        injected = opts.drawSource();
      } catch (e: unknown) {
        if (fireError !== undefined) {
          fireError(makeWorldUpdateError(e));
        }
        injected = undefined;
      }
    }
    if (injected !== undefined) {
      updateInjectedWorlds(injected.worlds, world, fireError);
    }

    try {
      // Single-world path (injected === undefined): wrap the own World into
      // [world] with owner 0 so the public Engine.create / createApp API stays
      // unchanged for single-world AI users (feat-20260708 M3 / AC-03; owner 0
      // is the single-world identity path worldId 0).
      //
      // Multi-world path (injected !== undefined): draw the host-supplied worlds
      // with the split { cameraOwner, resourceOwner } owners (M1 owner-split).
      // The worlds array is copied ([...worlds]) so the renderer never holds the
      // host's readonly reference.
      const drawResult =
        injected !== undefined
          ? renderer.draw([...injected.worlds], {
              cameraOwner: injected.cameraOwner,
              resourceOwner: injected.resourceOwner,
            })
          : renderer.draw([world], { owner: 0 });
      // renderer.draw may legacy-return undefined (older Renderer
      // builds) or the new Result<void, RhiError> shape. Treat
      // undefined as ok and only fan out on the err arm.
      if (drawResult !== undefined) {
        const r = drawResult as { ok: boolean; error?: RhiError };
        if (r.ok === false && r.error !== undefined && fireError !== undefined) {
          fireError(r.error);
        }
      }
    } catch (e: unknown) {
      // renderer.draw should never throw (it returns Result), but if a
      // backend bug surfaces a throw we still surface it via fan-out so
      // the frame loop does not silently swallow it.
      if (fireError !== undefined) {
        fireError(makeWorldUpdateError(e));
      }
    }
    pendingFrameId = raf(tick);
  }

  return {
    addUpdateCallback(fn: UpdateCallback): void {
      updateCallbacks.push(fn);
    },

    start(): Result<void, AppError> {
      if (state === 'running') {
        return err(
          makeAppError(
            'app-already-running',
            'state must be "idle" or "paused" to start',
            'call stop() first or check getState() before retrying',
            {},
          ),
        );
      }
      if (state === 'stopped') {
        return err(
          makeAppError(
            'app-not-started',
            'frame-loop is in terminal "stopped" state (e.g. device-lost)',
            'create a new App via createApp({...}); the existing handle is dead',
            {},
          ),
        );
      }
      // idle | paused -> running. The dt baseline is reset on every
      // transition into 'running' so resume()/start() avoid a phantom
      // multi-second dt accumulated during the pause.
      lastTimestamp = now();
      state = 'running';
      pendingFrameId = raf(tick);
      return ok(undefined);
    },

    stop(): Result<void, AppError> {
      if (state === 'idle') {
        return err(
          makeAppError(
            'app-not-started',
            'state must be "running" to stop',
            'check getState() before calling stop(); idle handles cannot stop',
            {},
          ),
        );
      }
      if (state === 'paused') {
        return err(
          makeAppError(
            'app-paused-while-stop',
            'state must be "running" to stop; paused handles must resume() first',
            'call resume() then stop(), or treat stop-while-paused as a host bug',
            {},
          ),
        );
      }
      if (state === 'stopped') {
        return err(
          makeAppError(
            'app-not-started',
            'frame-loop is in terminal "stopped" state',
            'discard this handle and create a new App',
            {},
          ),
        );
      }
      caf(pendingFrameId);
      pendingFrameId = 0;
      state = 'idle';
      return ok(undefined);
    },

    pause(): Result<void, AppError> {
      if (state === 'paused') {
        // idempotent
        return ok(undefined);
      }
      if (state !== 'running') {
        return err(
          makeAppError(
            'app-not-started',
            'state must be "running" or "paused" to pause',
            'call start() first; idle handles cannot pause',
            {},
          ),
        );
      }
      caf(pendingFrameId);
      pendingFrameId = 0;
      state = 'paused';
      return ok(undefined);
    },

    resume(): Result<void, AppError> {
      if (state === 'idle' || state === 'stopped') {
        return err(
          makeAppError(
            'app-not-started',
            'state must be "paused" to resume',
            'call start() first to leave idle; resume() expects an active handle',
            {},
          ),
        );
      }
      if (state === 'running') {
        // idempotent ok (resume on running is a no-op)
        return ok(undefined);
      }
      // paused -> running: reset dt baseline so the first post-resume
      // frame does not see a multi-second rawDt.
      lastTimestamp = now();
      state = 'running';
      pendingFrameId = raf(tick);
      return ok(undefined);
    },

    getState(): FrameState {
      return state;
    },

    setStopped(): void {
      if (pendingFrameId !== 0) {
        caf(pendingFrameId);
        pendingFrameId = 0;
      }
      state = 'stopped';
    },
  };
}

import { Update } from '@forgeax/engine-ecs';
// @forgeax/engine-app -- input attach + cleanup helper (M3 / w7).
//
// Public surface (consumed only by createApp -- this module lives under
// `internal/` and is not re-exported from the package barrel):
//
//   const handle = attachInputAuto(canvas, world);
//   handle.backend; // InputBackend exposed via app.input
//   handle.cleanup({ onError });  // detach + removeSystem (idempotent)
//
// Wiring (per plan-strategy section 7 M3 + research engine-input-public-contract):
//
//   1. const detach = attachBrowserInputBackend(canvas)
//      -- detach is a callable () => void with .backend: InputBackend mounted.
//   2. world.insertResource(INPUT_BACKEND_KEY, detach.backend) +
//      world.addSystems(Update, InputSet, [InputFrameStartScan])
//      -- registers the scan system whose stable name is
//      FRAME_START_SCAN_SYSTEM_NAME ('input-frame-start-scan'). The system
//      runs at frame-start each world.update(1 / 60).unwrap() and writes the frozen
//      InputSnapshot into world.getResource('InputSnapshot').
//
// Cleanup (R-4 -- stop / device-lost / exception triple-funnel):
//
//   1. detach() -- removes DOM listeners + exits PointerLock + drops
//      internal accumulators. Idempotent (calling twice is a no-op per the
//      browser-backend contract).
//   2. world.removeSystem(Update, FRAME_START_SCAN_SYSTEM_NAME)
//      -- returns Result<void, ScheduleMutationError>. On err, plan-strategy
//      D-4 says: wrap as AppError({ code: 'app-system-update-failed', detail:
//      { cause, systemName } }) and dispatch through onError. stop() still
//      returns Result.ok(undefined) -- the err is a side-channel signal, not
//      a stop-blocking failure (charter P3 explicit failure: the AI user
//      observes the failure via onError; the stop API itself stays simple).
//
// Architecture principle #1 SSOT: attach + cleanup share the same handle
// closure -- the InputBackend reference, the detach callable, and the
// scan-system-name constant are not re-derived elsewhere.
//
// Architecture principle #6 idempotency: cleanup() can be called multiple
// times; the second call is a no-op (detach is idempotent, removeSystem
// returns 'system-before-unknown' which we ignore on the second pass).

import type { World } from '@forgeax/engine-ecs';
import {
  type ActionConfig,
  attachBrowserInputBackend,
  type BrowserInputBackendOptions,
  FRAME_START_SCAN_SYSTEM_NAME,
  INPUT_BACKEND_KEY,
  INPUT_MAP_KEY,
  type InputBackend,
  type PointerLockProvider,
  type VirtualJoystickConfig,
} from '@forgeax/engine-input';

import { APP_ERROR_HINTS, APP_EXPECTED, AppError } from '../errors';

/**
 * Handle returned by attachInputAuto. Captures the backend (exposed via
 * App.input), the detach callable, and a cleanup() funnel that the
 * frame-loop / app-stop / device-lost paths share (R-4).
 */
export interface InputAttachHandle {
  readonly backend: InputBackend;
  cleanup(options: InputCleanupOptions): void;
  /**
   * M2: install the error dispatch callback for onLockError events.
   * Must be called by createApp after the ErrorFanoutRegistry is created
   * (the dispatch function is created after attachInputAuto returns).
   * Idempotent — subsequent calls replace the previous callback.
   */
  setOnErrorDispatch(fn: (err: AppError) => void): void;
}

/**
 * Options for cleanup(). The onError callback is invoked when
 * world.removeSystem returns Result.err -- the error is wrapped as an
 * AppError with code 'app-system-update-failed' per plan-strategy D-4.
 */
export interface InputCleanupOptions {
  readonly onError: (err: AppError) => void;
}

function makeAppError(
  code: 'app-system-update-failed',
  expected: string,
  hint: string,
  detail: { readonly cause: unknown; readonly systemName?: string | undefined },
): AppError {
  return new AppError({ code, expected, hint, detail });
}

/**
 * Attach DOM input listeners + register the frame-start scan system. The
 * caller (createApp assemble form, post-renderer) holds the returned
 * handle; cleanup() must be called when the app stops or on device-lost.
 *
 * Per plan-strategy D-2 (M2 full resource-ification): the backend is supplied
 * via the INPUT_BACKEND_KEY World resource; the InputFrameStartScan token reads
 * it back inside its fn.
 *
 * feat-20260623-plugin-system-unify (M2 / D-3): this helper now only performs
 * the DOM attach + resource injection. The frame-start scan system is
 * registered by inputPlugin() (the default plugin set), guarded by the
 * INPUT_BACKEND_KEY resource this helper inserts -- so the plugin owns the
 * addSystem (the unified SSOT for world-registration). The cleanup funnel
 * still owns the matching removeSystem because it owns the DOM / lifecycle
 * teardown (the plugin has no cleanup seam).
 */
/**
 * Options forwarded to attachBrowserInputBackend at attach time. Currently only
 * the neutral PointerLock gate (host decides whether a canvas click captures the
 * cursor); the backend stays host-opaque. Optional so existing call sites are
 * unchanged.
 */
export interface InputAttachOptions {
  readonly pointerLockAllowed?: () => boolean;
  /** M3: virtual joystick configurations passed through to browser backend. */
  readonly virtualJoysticks?: readonly VirtualJoystickConfig[];
  /**
   * M1: action mapping config. Normalized (last-wins dedup, D-8) then inserted as
   * a frozen readonly Resource under INPUT_MAP_KEY. Canvas-form only; assemble-form
   * hosts insert INPUT_MAP_KEY directly.
   */
  readonly inputMap?: readonly ActionConfig[] | undefined;
  /**
   * M2: pointer-lock provider injected by the host (e.g. editor play-runtime).
   * Forwarded to BrowserInputBackendOptions.lockProvider. When absent, the
   * backend falls back to the W3C requestPointerLock() path.
   * Type SSOT is @forgeax/engine-input's PointerLockProvider.
   */
  readonly lockProvider?: PointerLockProvider;
}

export function attachInputAuto(
  canvas: HTMLCanvasElement,
  world: World,
  options: InputAttachOptions = {},
): InputAttachHandle {
  // Mutable slot for error dispatch. The dispatch function is created by
  // createApp AFTER the ErrorFanoutRegistry is set up, so we need an
  // indirection: the backend's onLockError callback fires synchronously
  // inside the click handler, but the fan-out is ready by then because
  // createApp wires it before calling app.start().
  let onLockErrorDispatch: ((err: AppError) => void) | undefined;

  const backendOpts: BrowserInputBackendOptions = {
    ...(options.pointerLockAllowed ? { pointerLockAllowed: options.pointerLockAllowed } : {}),
    ...(options.virtualJoysticks ? { virtualJoysticks: options.virtualJoysticks } : {}),
    ...(options.lockProvider ? { lockProvider: options.lockProvider } : {}),
    onLockError: (detail: { path: 'w3c' | 'provider'; cause: unknown }) => {
      // D-4: wrap the backend's onLockError signal into a structured AppError
      // and fan-out through createApp's onError channel. The dispatch function
      // is installed by setOnErrorDispatch after createApp creates the
      // ErrorFanoutRegistry. If no dispatch is set yet (e.g. during unit tests
      // that don't call setOnErrorDispatch), the error is silently dropped.
      if (onLockErrorDispatch) {
        const err = new AppError({
          code: 'app-pointer-lock-failed',
          expected: APP_EXPECTED['app-pointer-lock-failed'],
          hint: APP_ERROR_HINTS['app-pointer-lock-failed'],
          detail,
        });
        onLockErrorDispatch(err);
      }
    },
  };
  const detach = attachBrowserInputBackend(canvas, backendOpts);
  const backend = detach.backend;
  world.insertResource(INPUT_BACKEND_KEY, backend);

  // M1: normalize inputMap + insert as frozen Resource.
  // D-8: last-wins dedup — later duplicate action names overwrite earlier.
  if (options.inputMap && options.inputMap.length > 0) {
    const deduped = new Map<string, ActionConfig>();
    for (const config of options.inputMap) {
      // Validate: action name must be non-empty.
      if (config.action.length === 0) {
        continue; // skip empty-name configs silently (P3: empty signal)
      }
      deduped.set(config.action, config);
    }
    const frozenInputMap: readonly ActionConfig[] = Object.freeze([...deduped.values()]);
    world.insertResource(INPUT_MAP_KEY, frozenInputMap);
  }

  let cleanedUp = false;

  return {
    backend,
    setOnErrorDispatch(fn: (err: AppError) => void): void {
      onLockErrorDispatch = fn;
    },
    cleanup(options: InputCleanupOptions): void {
      if (cleanedUp) {
        // idempotent: the device-lost path + the explicit stop path may
        // both reach cleanup -- second call is a no-op (charter P3 +
        // architecture principle #6).
        return;
      }
      cleanedUp = true;
      // detach() is idempotent at the browser-backend layer (double-detach
      // is safe per packages/input/src/browser-backend.ts); we still gate
      // here so the removeSystem leg does not run twice (which would
      // otherwise emit a spurious 'system-before-unknown' wrap).
      detach();
      const removeResult = world.removeSystem(Update, FRAME_START_SCAN_SYSTEM_NAME);
      if (!removeResult.ok) {
        const wrapped = makeAppError(
          'app-system-update-failed',
          `world.removeSystem(Update, '${FRAME_START_SCAN_SYSTEM_NAME}') to succeed during input cleanup`,
          'check that the scan system is still registered; if a host system removed it earlier, this signal is benign and can be ignored after onError dispatch',
          {
            cause: removeResult.error,
            systemName: FRAME_START_SCAN_SYSTEM_NAME,
          },
        );
        options.onError(wrapped);
      }
    },
  };
}

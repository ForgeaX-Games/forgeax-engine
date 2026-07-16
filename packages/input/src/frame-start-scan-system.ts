// frame-start-scan-system.ts -- bridges an `InputBackend` producer into
// the `InputSnapshot` Resource consumed by user systems (charter P5).
//
// Plan-strategy section 2.10 D-5 locks the system to a frame-start position
// in the schedule: user systems declare `after: ['input-frame-start-scan']`
// to read the snapshot. The system itself holds zero queries; it only
// pulls one sample from the backend and writes the Resource.
//
// M2 (full resource-ification, D-2 / D-4): the backend is supplied via the
// `InputBackend` World resource (INPUT_BACKEND_KEY) rather than a captured
// closure. The system is a module-level `defineSystem` token with the real fn
// body (no factory); `resources` declares the dependency so a missing backend
// routes through the structured ParamValidation 'invalid' path instead of a
// raw throw.

import { defineSystem, defineSystemSet, type SystemHandle } from '@forgeax/engine-ecs';
import {
  type ActionConfig,
  type ActionState,
  deriveActionStates,
  INPUT_MAP_KEY,
} from './action-state';
import {
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  type InputSnapshot,
  readActionStatesForEdgeDiff,
  snapshotFromSample,
} from './input-snapshot';

/**
 * Stable system name (locked by `frame-start-scan-system.test.ts`). User
 * systems reference it through `after: [FRAME_START_SCAN_SYSTEM_NAME]`
 * to ensure they observe the freshly written snapshot.
 */
export const FRAME_START_SCAN_SYSTEM_NAME = 'input-frame-start-scan';
export const InputSet = defineSystemSet({ name: 'input' });

/**
 * Resource key under which the {@link InputBackend} producer is inserted
 * (M2 — full resource-ification, D-2 / D-7). The frame-start scan system
 * declares it in `resources`; the fn body reads it back via
 * `world.getResource(INPUT_BACKEND_KEY)`.
 *
 * Aligns with the `INPUT_SNAPSHOT_RESOURCE_KEY` naming. Consumers import the
 * constant rather than the bare string so a typo degrades to an import error
 * (charter P3).
 */
export const INPUT_BACKEND_KEY = 'InputBackend' as const;

/**
 * The frame-start scan system token (M2 — full resource-ification, D-4).
 *
 * Module-level `defineSystem` with the real fn body — no factory, no closure.
 * Each `world.update()` tick:
 *   1. reads the {@link InputBackend} from `INPUT_BACKEND_KEY` and calls
 *      `backend.sample()` to drain the per-frame accumulator (movement delta +
 *      up-edge set);
 *   2. derives a fresh `InputSnapshot` via `snapshotFromSample`;
 *   3. writes it under `INPUT_SNAPSHOT_RESOURCE_KEY` via
 *      `world.insertResource` -- idempotent overwrite, charter P4
 *      consistent abstraction (consumers always read the same Resource key
 *      regardless of which backend produced the sample).
 *
 * Labelled `'input'` (spec §6.2 label-anchor map).
 */
export const InputFrameStartScan: SystemHandle<readonly []> = defineSystem({
  name: FRAME_START_SCAN_SYSTEM_NAME,
  queries: [],
  resources: [INPUT_BACKEND_KEY],
  fn: (world) => {
    const backend = world.getResource<InputBackend>(INPUT_BACKEND_KEY);
    const sample = backend.sample();

    // Action mapping: derive states from InputMap Resource + prev snapshot edges.
    // D-6: edge baseline reuses existing prev InputSnapshot Resource (Derive,
    // Don't Duplicate — zero new cross-frame state carrier).
    let actionStates: ReturnType<typeof deriveActionStates> | undefined;
    let inputMap: readonly ActionConfig[] | undefined;
    if (world.hasResource(INPUT_MAP_KEY)) {
      inputMap = world.getResource<readonly ActionConfig[]>(INPUT_MAP_KEY);
      // Read prev snapshot's internal action states for edge diff.
      // First frame: no prev snapshot → justPressed = pressed (same as Feat1 gamepad).
      let prevActionStates: readonly ActionState[] | undefined;
      if (world.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)) {
        const prevSnap = world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY);
        prevActionStates = readActionStatesForEdgeDiff(prevSnap);
      }
      actionStates = deriveActionStates(sample, inputMap, prevActionStates);
    }

    const snapshot = snapshotFromSample(sample, actionStates, inputMap);
    world.insertResource(INPUT_SNAPSHOT_RESOURCE_KEY, snapshot);
  },
});

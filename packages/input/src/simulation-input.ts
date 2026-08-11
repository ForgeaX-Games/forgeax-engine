import {
  createSimulationError,
  createSimulationTrace,
  err,
  FixedTime,
  type Result,
  registerFixedTickHook,
  type SimulationError,
  type SimulationTrace,
  type SimulationTraceRecorder,
  type World,
} from '@forgeax/engine-ecs';
import type { ActionState } from './action-state';
import type { GestureEvent, GestureState } from './gesture-recognizer';
import type {
  Capabilities,
  GamepadSlotSample,
  InputSnapshot,
  PointerPhaseEvent,
  PointerSample,
  VirtualAxisSample,
} from './input-snapshot';
import { INPUT_SNAPSHOT_RESOURCE_KEY } from './input-snapshot';

export const INPUT_SIMULATION_SAMPLE_RESOURCE_KEY = 'SimulationInputSample';

/** Immutable fixed-tick input projection suitable for trace records and semantic inspection. */
export interface SimulationInputSample {
  readonly keyboard: {
    readonly downKeys: readonly string[];
    readonly justPressedKeys: readonly string[];
    readonly upKeys: readonly string[];
    readonly downCodes: readonly string[];
    readonly justPressedCodes: readonly string[];
    readonly upCodes: readonly string[];
  };
  readonly mouse: {
    readonly position: { readonly x: number; readonly y: number } | undefined;
    readonly movementDelta: { readonly x: number; readonly y: number };
    readonly pointerLocked: boolean;
    readonly buttons: readonly [boolean, boolean, boolean];
    readonly justPressedButtons: readonly [boolean, boolean, boolean];
    readonly justReleasedButtons: readonly [boolean, boolean, boolean];
    readonly wheelDelta: number;
  };
  readonly gamepads: readonly GamepadSlotSample[];
  readonly capabilities: Capabilities;
  readonly pointers: readonly PointerSample[];
  readonly pointerEvents: readonly PointerPhaseEvent[];
  readonly virtualAxes: readonly VirtualAxisSample[];
  readonly gestures: GestureState;
  readonly gestureEvents: readonly GestureEvent[];
  readonly actions: readonly ActionState[];
}

interface SimulationInputFacts {
  readonly raw: {
    readonly downKeys: readonly string[];
    readonly upKeys: readonly string[];
    readonly downCodes: readonly string[];
    readonly upCodes: readonly string[];
    readonly buttons: readonly [boolean, boolean, boolean];
    readonly movementX: number;
    readonly movementY: number;
    readonly mouseX?: number;
    readonly mouseY?: number;
    readonly wheelDelta: number;
    readonly pointerLocked: boolean;
    readonly gamepads?: readonly GamepadSlotSample[];
    readonly capabilities?: Capabilities;
    readonly pointers?: readonly PointerSample[];
    readonly pointerEvents?: readonly PointerPhaseEvent[];
    readonly virtualAxes?: readonly VirtualAxisSample[];
    readonly gestures?: GestureState;
    readonly gestureEvents?: readonly GestureEvent[];
  };
  readonly justPressedKeys: readonly string[];
  readonly justPressedCodes: readonly string[];
  readonly justPressedButtons: readonly [boolean, boolean, boolean];
  readonly justReleasedButtons: readonly [boolean, boolean, boolean];
  readonly actionStates?: readonly ActionState[];
}

function factsOf(snapshot: InputSnapshot): SimulationInputFacts {
  const facts = (snapshot as unknown as { _simulationInputFacts?: SimulationInputFacts })
    ._simulationInputFacts;
  if (facts === undefined) {
    throw new Error('InputSnapshot was not produced by snapshotFromSample');
  }
  return facts;
}

function cloneGamepads(gamepads: readonly GamepadSlotSample[]): readonly GamepadSlotSample[] {
  return gamepads.map((slot) =>
    Object.freeze({
      index: slot.index,
      standardMapping: slot.standardMapping,
      pressed: new Set(slot.pressed),
      justPressed: new Set(slot.justPressed),
      justReleased: new Set(slot.justReleased),
      buttonValues: new Map(slot.buttonValues),
      axes: [...slot.axes] as [number, number, number, number],
    }),
  );
}

function clonePointers(pointers: readonly PointerSample[]): readonly PointerSample[] {
  return pointers.map((pointer) =>
    Object.freeze({
      ...pointer,
      delta: Object.freeze({ x: pointer.delta.x, y: pointer.delta.y }),
    }),
  );
}

function clonePointerEvents(events: readonly PointerPhaseEvent[]): readonly PointerPhaseEvent[] {
  return events.map((event) => Object.freeze({ ...event }));
}

function cloneVirtualAxes(axes: readonly VirtualAxisSample[]): readonly VirtualAxisSample[] {
  return axes.map((axis) => Object.freeze({ ...axis }));
}

/** Project the frame-start snapshot; do not read DOM devices or create a second recorder. */
export function projectSimulationInputSample(snapshot: InputSnapshot): SimulationInputSample {
  const facts = factsOf(snapshot);
  const raw = facts.raw;
  const position =
    raw.mouseX === undefined || raw.mouseY === undefined
      ? undefined
      : Object.freeze({ x: raw.mouseX, y: raw.mouseY });
  const sample: SimulationInputSample = {
    keyboard: Object.freeze({
      downKeys: Object.freeze([...raw.downKeys]),
      justPressedKeys: Object.freeze([...facts.justPressedKeys]),
      upKeys: Object.freeze([...raw.upKeys]),
      downCodes: Object.freeze([...raw.downCodes]),
      justPressedCodes: Object.freeze([...facts.justPressedCodes]),
      upCodes: Object.freeze([...raw.upCodes]),
    }),
    mouse: Object.freeze({
      position,
      movementDelta: Object.freeze({ x: raw.movementX, y: raw.movementY }),
      pointerLocked: raw.pointerLocked,
      buttons: Object.freeze([...raw.buttons]) as [boolean, boolean, boolean],
      justPressedButtons: Object.freeze([...facts.justPressedButtons]) as [
        boolean,
        boolean,
        boolean,
      ],
      justReleasedButtons: Object.freeze([...facts.justReleasedButtons]) as [
        boolean,
        boolean,
        boolean,
      ],
      wheelDelta: raw.wheelDelta,
    }),
    gamepads: Object.freeze(cloneGamepads(raw.gamepads ?? [])),
    capabilities: Object.freeze({ ...(raw.capabilities ?? { gamepad: false, pointer: false }) }),
    pointers: Object.freeze(clonePointers(raw.pointers ?? [])),
    pointerEvents: Object.freeze(clonePointerEvents(raw.pointerEvents ?? [])),
    virtualAxes: Object.freeze(cloneVirtualAxes(raw.virtualAxes ?? [])),
    gestures: raw.gestures ?? Object.freeze({ pinchScale: 1, rotationAngle: 0 }),
    gestureEvents: Object.freeze(
      (raw.gestureEvents ?? []).map((event) => Object.freeze({ ...event })),
    ),
    actions: Object.freeze(
      (facts.actionStates ?? []).map((action) => Object.freeze({ ...action })),
    ),
  };
  return Object.freeze(sample);
}

export interface SimulationInputController {
  readonly finish: () => Result<SimulationTrace, SimulationError>;
  readonly dispose: () => void;
}

/** Connect input recording or trace consumption to FixedUpdate through the existing ECS hook. */
export function installSimulationInput(
  world: World,
  options: { readonly replay?: SimulationTrace } = {},
): SimulationInputController {
  const replay = options.replay;
  const recorder: SimulationTraceRecorder = createSimulationTrace(
    world.getResource(FixedTime).tick,
  );
  let failure: SimulationError | undefined;
  const unregister = registerFixedTickHook(world, (target, tick) => {
    if (failure !== undefined) return;
    if (replay !== undefined) {
      const sample = replay.samples[tick - replay.recordTick - 1];
      if (sample === undefined) {
        failure = createSimulationError('simulation-trace-invalid', {
          path: `samples[${tick - replay.recordTick - 1}].tick`,
          expected: `${tick}`,
          received: undefined,
        });
        return;
      }
      target.insertResource(INPUT_SIMULATION_SAMPLE_RESOURCE_KEY, sample.input);
      return;
    }
    if (!target.hasResource(INPUT_SNAPSHOT_RESOURCE_KEY)) {
      failure = createSimulationError('simulation-trace-invalid', {
        path: 'InputSnapshot',
        expected: 'a frame-start InputSnapshot before FixedUpdate',
      });
      return;
    }
    const input = projectSimulationInputSample(
      target.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY),
    );
    const appended = recorder.append({ tick, input });
    if (!appended.ok) {
      failure = appended.error;
      return;
    }
    target.insertResource(INPUT_SIMULATION_SAMPLE_RESOURCE_KEY, input);
  });

  return {
    finish: () => {
      if (failure !== undefined) return err(failure);
      return recorder.finish();
    },
    dispose: unregister,
  };
}

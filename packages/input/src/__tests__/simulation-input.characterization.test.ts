import { FixedUpdate, Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { INPUT_BACKEND_KEY, InputFrameStartScan } from '../frame-start-scan-system';
import {
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  type InputBackendSample,
  type InputSnapshot,
  snapshotFromSample,
} from '../input-snapshot';

function sample(overrides: Partial<InputBackendSample> = {}): InputBackendSample {
  return {
    downKeys: new Set(['jump']),
    upKeys: new Set(['old-key']),
    downCodes: new Set(['Space']),
    upCodes: new Set(['KeyO']),
    buttons: [true, false, false],
    movementX: 3,
    movementY: -2,
    mouseX: 40,
    mouseY: 50,
    wheelDelta: -1,
    focused: true,
    capabilities: { gamepad: false, pointer: true },
    pointerLocked: false,
    ...overrides,
  };
}

function backend(samples: readonly InputBackendSample[]): InputBackend & { sampleCalls: number } {
  let index = 0;
  const result: InputBackend & { sampleCalls: number } = {
    sampleCalls: 0,
    sample: () => {
      result.sampleCalls += 1;
      const next = samples[Math.min(index, samples.length - 1)];
      index += 1;
      if (next === undefined) throw new Error('simulation input fixture exhausted');
      return next;
    },
    detach: () => undefined,
  };
  return result;
}

describe('M1 fixed tick input characterization', () => {
  it('projects the complete frame-start sample and preserves edge semantics', () => {
    const first = snapshotFromSample(sample());
    const released = snapshotFromSample(
      sample({
        downKeys: new Set(),
        upKeys: new Set(['jump']),
        downCodes: new Set(),
        upCodes: new Set(['Space']),
        buttons: [false, false, false],
        pointerLocked: true,
      }),
      undefined,
      undefined,
      first,
    );

    expect(first.keyboard.down('jump')).toBe(true);
    expect(first.keyboard.justPressed('jump')).toBe(true);
    expect(first.keyboard.downCode('Space')).toBe(true);
    expect(first.keyboard.justPressedCode('Space')).toBe(true);
    expect(first.keyboard.upCode('KeyO')).toBe(true);
    expect(first.mouse.button(0)).toBe(true);
    expect(first.mouse.justPressed(0)).toBe(true);
    expect(first.mouse.justReleased(0)).toBe(false);
    expect(first.mouse.movementDelta).toEqual({ x: 3, y: -2 });
    expect(first.mouse.position).toEqual({ x: 40, y: 50 });
    expect(first.mouse.pointerLocked).toBe(false);
    expect(first.mouse.wheelDelta).toBe(-1);
    expect(first.capabilities).toEqual({ gamepad: false, pointer: true });
    expect(first.gamepad(0).connected).toBe(false);
    expect(first.pointer(7)).toEqual({
      active: false,
      pointerId: -1,
      x: 0,
      y: 0,
      pressure: 0,
      pointerType: 'mouse',
      delta: { x: 0, y: 0 },
    });
    expect(first.virtualAxis('missing')).toEqual({ x: 0, y: 0 });
    expect(first.pointerEvents).toEqual([]);
    expect(first.gesture).toEqual({ pinchScale: 1, rotationAngle: 0 });
    expect(first.gestureEvents).toEqual([]);
    expect(released.keyboard.up('jump')).toBe(true);
    expect(released.keyboard.justPressed('jump')).toBe(false);
    expect(released.keyboard.upCode('Space')).toBe(true);
    expect(released.mouse.justPressed(0)).toBe(false);
    expect(released.mouse.justReleased(0)).toBe(true);
    expect(released.mouse.pointerLocked).toBe(true);
  });

  it('samples once at host frame start and reuses that snapshot for multiple fixed ticks', () => {
    const input = backend([sample()]);
    const world = new World();
    const snapshots: InputSnapshot[] = [];
    world.insertResource(INPUT_BACKEND_KEY, input);
    world.addSystem(Update, InputFrameStartScan);
    world.addSystem(FixedUpdate, {
      name: 'simulation-input-facts-fixed-consumer',
      queries: [],
      fn: (_world) => snapshots.push(_world.getResource(INPUT_SNAPSHOT_RESOURCE_KEY)),
    });

    expect(world.update(1 / 30).ok).toBe(true);
    expect(input.sampleCalls).toBe(1);
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(snapshots[0]?.keyboard.down('jump')).toBe(true);
  });
});

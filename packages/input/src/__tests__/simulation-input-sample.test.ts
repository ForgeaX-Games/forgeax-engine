import { FixedUpdate, Update, World } from '@forgeax/engine-ecs';
import { describe, expect, it } from 'vitest';
import { INPUT_BACKEND_KEY, InputFrameStartScan } from '../frame-start-scan-system';
import {
  INPUT_SNAPSHOT_RESOURCE_KEY,
  type InputBackend,
  type InputBackendSample,
  type InputSnapshot,
} from '../input-snapshot';
import {
  INPUT_SIMULATION_SAMPLE_RESOURCE_KEY,
  installSimulationInput,
  type SimulationInputSample,
} from '../simulation-input';

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

describe('fixed tick simulation input sample', () => {
  it('installs one complete portable sample for every executed fixed tick', () => {
    const input = backend([sample()]);
    const world = new World();
    const installed: SimulationInputSample[] = [];
    world.insertResource(INPUT_BACKEND_KEY, input);
    world.addSystem(Update, InputFrameStartScan);
    const seam = installSimulationInput(world);
    world.addSystem(FixedUpdate, {
      name: 'simulation-input-sample-consumer',
      queries: [],
      fn: (_world) => {
        installed.push(_world.getResource(INPUT_SIMULATION_SAMPLE_RESOURCE_KEY));
      },
    });

    expect(world.update(1 / 30).ok).toBe(true);
    expect(input.sampleCalls).toBe(1);
    expect(installed).toHaveLength(2);
    expect(installed[0]).toEqual(installed[1]);
    expect(installed[0]).toMatchObject({
      keyboard: {
        downKeys: ['jump'],
        justPressedKeys: ['jump'],
        upKeys: ['old-key'],
        downCodes: ['Space'],
        upCodes: ['KeyO'],
      },
      mouse: {
        position: { x: 40, y: 50 },
        movementDelta: { x: 3, y: -2 },
        buttons: [true, false, false],
        wheelDelta: -1,
      },
      capabilities: { gamepad: false, pointer: true },
    });
    expect(
      world.getResource<InputSnapshot>(INPUT_SNAPSHOT_RESOURCE_KEY).keyboard.down('jump'),
    ).toBe(true);
    expect(seam.finish().ok).toBe(true);
  });
});

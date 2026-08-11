import { describe, expect, it } from 'vitest';
import { type InputBackendSample, snapshotFromSample } from '../input-snapshot';
import { projectSimulationInputSample } from '../simulation-input';

function sample(overrides: Partial<InputBackendSample> = {}): InputBackendSample {
  return {
    downKeys: new Set(['jump']),
    upKeys: new Set(),
    downCodes: new Set(['Space']),
    upCodes: new Set(),
    buttons: [true, false, false],
    movementX: 2,
    movementY: -1,
    mouseX: 12,
    mouseY: 24,
    wheelDelta: 1,
    focused: true,
    capabilities: { gamepad: false, pointer: true },
    pointerLocked: true,
    ...overrides,
  };
}

describe('simulation input host grouping edges', () => {
  it('keeps one tick sample stable when host grouping changes', () => {
    const held = snapshotFromSample(sample());
    const released = snapshotFromSample(
      sample({ downKeys: new Set(), upKeys: new Set(['jump']), downCodes: new Set() }),
      undefined,
      undefined,
      held,
    );

    const heldSample = projectSimulationInputSample(held);
    const groupedHeldSamples = [
      projectSimulationInputSample(held),
      projectSimulationInputSample(held),
    ];
    const releasedSample = projectSimulationInputSample(released);

    expect(groupedHeldSamples[0]).toEqual(groupedHeldSamples[1]);
    expect(groupedHeldSamples[0]).toEqual(heldSample);
    expect(heldSample.keyboard.justPressedKeys).toEqual(['jump']);
    expect(releasedSample.keyboard.justPressedKeys).toEqual([]);
    expect(releasedSample.keyboard.upKeys).toEqual(['jump']);
    expect(releasedSample.keyboard.upCodes).toEqual([]);
    expect(releasedSample.mouse.buttons).toEqual([true, false, false]);
    expect(releasedSample.mouse.movementDelta).toEqual({ x: 2, y: -1 });
  });
});

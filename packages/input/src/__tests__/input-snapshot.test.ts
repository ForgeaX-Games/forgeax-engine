import { describe, expect, it } from 'vitest';

import {
  createEmptyInputBackendSample,
  type InputBackendSample,
  snapshotFromSample,
} from '../input-snapshot';

function sample(
  downKeys: string[],
  upKeys: string[] = [],
  downCodes: string[] = [],
  upCodes: string[] = [],
): InputBackendSample {
  return {
    downKeys: new Set(downKeys),
    upKeys: new Set(upKeys),
    downCodes: new Set(downCodes),
    upCodes: new Set(upCodes),
    buttons: [false, false, false],
    movementX: 0,
    movementY: 0,
    wheelDelta: 0,
    focused: true,
    pointerLocked: false,
  };
}

describe('keyboard snapshot edges', () => {
  it('derives justPressed from the previous frozen snapshot', () => {
    const first = snapshotFromSample(sample(['a']));
    const held = snapshotFromSample(sample(['a']), undefined, undefined, first);
    const released = snapshotFromSample(sample([], ['a']), undefined, undefined, held);

    expect(first.keyboard.down('a')).toBe(true);
    expect(first.keyboard.justPressed('a')).toBe(true);
    expect(held.keyboard.justPressed('a')).toBe(false);
    expect(released.keyboard.down('a')).toBe(false);
    expect(released.keyboard.up('a')).toBe(true);
  });

  it('keeps code-like and logical key strings as independent read points', () => {
    const snap = snapshotFromSample(sample(['?'], [], ['KeyA']));

    expect(snap.keyboard.down('?')).toBe(true);
    expect(snap.keyboard.justPressed('?')).toBe(true);
    expect(snap.keyboard.downCode('KeyA')).toBe(true);
    expect(snap.keyboard.justPressedCode('KeyA')).toBe(true);
  });
});

describe('empty backend sample ownership', () => {
  it('keeps the neutral sample owner out of the public root', async () => {
    const root = (await import('../index')) as Record<string, unknown>;
    const empty = createEmptyInputBackendSample();

    expect(root).not.toHaveProperty('createEmptyInputBackendSample');
    expect(empty.downKeys.size).toBe(0);
    expect(empty.upKeys.size).toBe(0);
    expect(empty.buttons).toEqual([false, false, false]);
    expect(empty.movementX).toBe(0);
    expect(empty.movementY).toBe(0);
    expect(empty.wheelDelta).toBe(0);
    expect(empty.focused).toBe(true);
    expect(empty.pointerLocked).toBe(false);
  });
});

describe('mouse snapshot edges', () => {
  it('derives primary-button held, press, and release edges from snapshots', () => {
    const first = snapshotFromSample({
      ...sample([]),
      buttons: [true, false, false],
    });
    const held = snapshotFromSample(
      { ...sample([]), buttons: [true, false, false] },
      undefined,
      undefined,
      first,
    );
    const released = snapshotFromSample(
      { ...sample([]), buttons: [false, false, false] },
      undefined,
      undefined,
      held,
    );

    expect(first.mouse.button(0)).toBe(true);
    expect(first.mouse.justPressed(0)).toBe(true);
    expect(first.mouse.justReleased(0)).toBe(false);
    expect(held.mouse.justPressed(0)).toBe(false);
    expect(held.mouse.justReleased(0)).toBe(false);
    expect(released.mouse.button(0)).toBe(false);
    expect(released.mouse.justReleased(0)).toBe(true);
  });
});

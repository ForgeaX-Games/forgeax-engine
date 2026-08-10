import type { InputBackendSample } from '@forgeax/engine-input';
import { describe, expect, it } from 'vitest';
import { FrameCreditLedger } from '../execution/protocol';

const sample: InputBackendSample = {
  downKeys: new Set(),
  upKeys: new Set(),
  buttons: [false, false, false],
  movementX: 0,
  movementY: 0,
  wheelDelta: 0,
  focused: true,
  pointerLocked: false,
};

describe('frame credit protocol', () => {
  it('allows one in-flight frame and handles duplicate, late and old identities without writes', () => {
    const ledger = new FrameCreditLedger('world-1');
    const first = ledger.issue(0.016, () => sample);
    expect(first?.frameId).toBe(1);
    expect(ledger.issue(0.016, () => sample)).toBeUndefined();
    expect(
      ledger.complete({
        kind: 'frame-complete',
        worldIdentity: 'old',
        frameId: 1,
        engineUpdateMs: 1,
        kernelWaitMs: 0,
      }),
    ).toBe('stale-world');
    expect(
      ledger.complete({
        kind: 'frame-complete',
        worldIdentity: 'world-1',
        frameId: 2,
        engineUpdateMs: 1,
        kernelWaitMs: 0,
      }),
    ).toBe('late');
    expect(
      ledger.complete({
        kind: 'frame-complete',
        worldIdentity: 'world-1',
        frameId: 1,
        engineUpdateMs: 1,
        kernelWaitMs: 0,
      }),
    ).toBe('accepted');
    expect(
      ledger.complete({
        kind: 'frame-complete',
        worldIdentity: 'world-1',
        frameId: 1,
        engineUpdateMs: 1,
        kernelWaitMs: 0,
      }),
    ).toBe('duplicate');
    expect(ledger.issue(0.016, () => sample)?.frameId).toBe(2);
  });
});

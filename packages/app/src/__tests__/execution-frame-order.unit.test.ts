import type { InputBackendSample } from '@forgeax/engine-input';
import { describe, expect, it } from 'vitest';
import { FrameCreditLedger } from '../execution/protocol';

describe('execution frame ordering', () => {
  it('samples once and cannot issue the next credit before update, draw and completion', () => {
    const trace: string[] = [];
    let samples = 0;
    const sample = (): InputBackendSample => {
      samples += 1;
      trace.push('sample');
      return {
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      };
    };
    const ledger = new FrameCreditLedger('world');
    const frame = ledger.issue(1 / 60, sample);
    expect(ledger.issue(1 / 60, sample)).toBeUndefined();
    trace.push('update', 'draw');
    ledger.complete({
      kind: 'frame-complete',
      worldIdentity: 'world',
      frameId: frame?.frameId ?? 0,
      engineUpdateMs: 1,
      kernelWaitMs: 0,
    });
    trace.push('complete');
    expect(trace).toEqual(['sample', 'update', 'draw', 'complete']);
    expect(samples).toBe(1);
  });
});

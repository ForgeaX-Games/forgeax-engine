import { describe, expect, it } from 'vitest';
import { captureFramesToMemory } from '../capture-browser';

describe('captureFramesToMemory', () => {
  it('clears a previous snapshot error before a browser retry', async () => {
    let disposed = 0;
    const debugInst = {
      arm: () => ({ ok: true as const }),
      disposeError: () => {
        disposed += 1;
      },
      snapshotAllLiveResources: () => new Promise<{ ok: true }>(() => {}),
      transitionToError: () => {},
      getState: () => 'error',
      getEvents: () => [],
      getTape: () => undefined,
      _getValid: () => false,
    };

    await expect(
      captureFramesToMemory(debugInst, 1, undefined, { snapshotTimeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'snapshot-timeout' });
    expect(disposed).toBe(1);
  });

  it('bounds a stuck frame-header snapshot and transitions the recorder to error', async () => {
    let transitionCount = 0;
    const debugInst = {
      arm: () => ({ ok: true as const }),
      snapshotAllLiveResources: () => new Promise<{ ok: true }>(() => {}),
      transitionToError: () => {
        transitionCount += 1;
      },
      getState: () => 'snapshotting',
      getEvents: () => [],
      getTape: () => undefined,
      _getValid: () => false,
    };

    await expect(
      captureFramesToMemory(debugInst, 1, undefined, { snapshotTimeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'snapshot-timeout' });
    expect(transitionCount).toBe(1);
  });
});

import type { RhiDevice } from '@forgeax/engine-rhi';
import { describe, expect, it } from 'vitest';
import { createDebugRhiAdapter } from '../adapter';
import type { DebugRhiInstance } from '../recorder';

describe('createDebugRhiAdapter capture recovery', () => {
  it('clears a terminal capture error before the public retry', async () => {
    let state = 'error';
    let disposeCount = 0;
    const debugInst = {
      getState: () => state,
      disposeError: () => {
        disposeCount += 1;
        state = 'idle';
      },
      arm: () => {
        state = 'armed';
        return { ok: true as const };
      },
      snapshotAllLiveResources: async () => {
        state = 'idle';
        return { ok: true as const };
      },
      getEvents: () => [{ kind: 'frameMark', frameIdx: 0 }],
      finalize: () => ({
        ok: true as const,
        value: {
          runId: 'recovery-test',
          tapePath: '.forgeax-debug/recovery-test/frame-0.tape.bin',
          reportPath: '.forgeax-debug/recovery-test/frame-0.report.json',
        },
      }),
    } as unknown as DebugRhiInstance;

    const adapter = createDebugRhiAdapter({
      debugInst,
      device: {} as unknown as RhiDevice,
    });
    const result = await adapter.captureFrames(1, 'recovery-test');

    expect(result.tapes).toHaveLength(1);
    expect(disposeCount).toBe(1);
    expect(state).toBe('idle');
  });
});

import { RhiError } from '@forgeax/engine-rhi';
import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { exposeRenderer } from '../assembly/factory';
import type {
  RendererHostEventListener,
  RendererHostImplementation,
} from '../assembly/host-contract';
import { RendererContractFailureError } from '../errors/render';

describe('exposeRenderer error projection', () => {
  it('reports an internal draw contract failure as a device operation failure', () => {
    const host = {
      inspect: () => ({ state: 'alive' }),
      subscribeHostEvents: () => () => undefined,
      drawFrame: () =>
        err(
          new RendererContractFailureError(
            'draw',
            'the Standard render owner did not submit a command buffer',
          ),
        ),
    } as unknown as RendererHostImplementation;
    const renderer = exposeRenderer(host);

    const result = renderer.draw({} as never);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('device-operation-failed');
      if (result.error.code !== 'device-operation-failed') return;
      expect(result.error.detail.cause).toMatchObject({
        code: 'renderer-contract-failed',
        detail: { operation: 'draw' },
      });
    }
  });
  it('preserves the current draw owner failure instead of masking it with a submit contract error', () => {
    let publish: RendererHostEventListener | undefined;
    let reportCause = true;
    const cause = new RhiError({
      code: 'rhi-not-available',
      expected: 'the current frame owner can record its resource',
      hint: 'inspect the failing resource owner',
    });
    const host = {
      inspect: () => ({ state: 'alive' }),
      subscribeHostEvents: (listener: RendererHostEventListener) => {
        publish = listener;
        return () => {
          publish = undefined;
        };
      },
      drawFrame: () => {
        if (reportCause) publish?.({ kind: 'error', error: cause });
        return err(new RendererContractFailureError('draw', 'no command buffer was submitted'));
      },
    } as unknown as RendererHostImplementation;
    const renderer = exposeRenderer(host);
    const failed = renderer.draw({} as never);
    expect(failed.ok).toBe(false);
    if (failed.ok || failed.error.code !== 'device-operation-failed')
      throw new Error('draw must fail');
    expect(failed.error.detail.cause.code).toBe('rhi-not-available');
    expect(failed.error.detail.cause.hint).toBe(cause.hint);
    reportCause = false;
    const next = renderer.draw({} as never);
    expect(next.ok).toBe(false);
    if (next.ok || next.error.code !== 'device-operation-failed') throw new Error('draw must fail');
    expect(next.error.detail.cause.code).toBe('renderer-contract-failed');
  });
});

import { err } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import { exposeRenderer } from '../assembly/factory';
import type { RendererHostImplementation } from '../assembly/host-contract';
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
});

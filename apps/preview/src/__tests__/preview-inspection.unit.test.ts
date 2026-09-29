import type { App } from '@forgeax/engine-app';
import { describe, expect, it } from 'vitest';
import { createPreviewInspection } from '../preview-inspection';

describe('Preview renderer recovery inspection', () => {
  it('preserves the renderer error identity and nested structured detail', async () => {
    const app = {
      assets: {},
      renderer: {
        inspect: () =>
          ({
            state: 'device-lost',
            surface: 'available',
            frame: { frameId: 4, deviceGeneration: 2 },
            features: [],
          }) as never,
        recover: async () =>
          ({
            ok: false,
            error: {
              code: 'recovery-failed',
              expected: 'a replacement generation publishes atomically',
              hint: 'inspect detail and retry after repairing the owner',
              detail: {
                phase: 'compile-graph',
                cause: {
                  code: 'shader-compile-failed',
                  detail: { compiler: { messages: [{ line: 7, message: 'invalid binding' }] } },
                },
                cleanupFailures: [],
              },
            },
          }) as never,
      },
    } as unknown as App;

    const { inspection } = createPreviewInspection(app, () => undefined);
    const result = await inspection.renderer.recover();

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'recovery-failed',
        expected: 'a replacement generation publishes atomically',
        hint: 'inspect detail and retry after repairing the owner',
        detail: {
          phase: 'compile-graph',
          cause: {
            code: 'shader-compile-failed',
            detail: { compiler: { messages: [{ line: 7, message: 'invalid binding' }] } },
          },
          cleanupFailures: [],
        },
      },
    });
  });
});

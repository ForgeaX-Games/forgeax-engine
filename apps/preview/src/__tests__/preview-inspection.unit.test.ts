import type { App } from '@forgeax/engine-app';
import { describe, expect, it } from 'vitest';
import { createPreviewInspection } from '../preview-inspection';

describe('Preview renderer recovery inspection', () => {
  it('constructs the registrar without publishing a partially started App', () => {
    const host = globalThis as Record<string, unknown>;
    const previous = host.__forgeaxPreviewInspection;
    delete host.__forgeaxPreviewInspection;
    const cleanups: Array<() => void> = [];
    try {
      const { inspection } = createPreviewInspection({ assets: {} } as App, (cleanup) =>
        cleanups.push(cleanup),
      );
      expect(host.__forgeaxPreviewInspection).toBeUndefined();
      // The Preview startup owner publishes this object only after native roots activate.
      host.__forgeaxPreviewInspection = inspection;
      for (const cleanup of cleanups) cleanup();
      expect(host.__forgeaxPreviewInspection).toBeUndefined();
    } finally {
      if (previous === undefined) delete host.__forgeaxPreviewInspection;
      else host.__forgeaxPreviewInspection = previous;
    }
  });

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

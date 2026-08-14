import { beforeEach, describe, expect, it, vi } from 'vitest';

const probes = vi.hoisted(() => ({
  audioDispose: vi.fn(),
  inputDetach: vi.fn(),
  sessionDispose: vi.fn(),
  sessionListen: vi.fn(() => () => {}),
  sessionPost: vi.fn(),
}));

vi.mock('../execution/engine-worker', async () => {
  const { ok } = await import('@forgeax/engine-types');
  return {
    startEngineWorker: vi.fn(async () =>
      ok({
        worker: {},
        ready: {
          kind: 'ready' as const,
          worldIdentity: 'worker-world',
          realm: 'worker' as const,
          workerWebGpu: true,
        },
        post: probes.sessionPost,
        listen: probes.sessionListen,
        dispose: probes.sessionDispose,
      }),
    ),
  };
});

vi.mock('@forgeax/engine-input', () => ({
  attachBrowserInputBackend: vi.fn(() => {
    const detach = probes.inputDetach as typeof probes.inputDetach & {
      backend: { sample(): object; detach(): void };
    };
    detach.backend = {
      sample: () => ({
        downKeys: new Set(),
        upKeys: new Set(),
        buttons: [false, false, false],
        movementX: 0,
        movementY: 0,
        wheelDelta: 0,
        focused: true,
        pointerLocked: false,
      }),
      detach: probes.inputDetach,
    };
    return detach;
  }),
}));

vi.mock('@forgeax/engine-audio-webaudio', () => ({
  createHostAudioConsumer: vi.fn(() => ({
    consume: vi.fn(),
    dispose: probes.audioDispose,
    state: () => ({ contextState: 'suspended', activeSourceCount: 0, lastError: null }),
  })),
}));

import { createWorkerExecutionApp } from '../execution/host-controller';

const capabilities = {
  worker: { available: true, reason: 'test' },
  offscreenCanvas: { available: true, reason: 'test' },
  workerAnimationFrame: { available: true, reason: 'test' },
  workerWebGpu: { available: true, reason: 'test' },
  crossOriginIsolated: { available: false, reason: 'test' },
  sharedArrayBuffer: { available: false, reason: 'test' },
  atomicsWait: { available: false, reason: 'test' },
} as const;

describe('Worker ExecutionApp terminal stop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cleans every host owner once when stopped while paused and cannot restart', async () => {
    const raf = vi.fn(() => 7);
    const cancelRaf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('cancelAnimationFrame', cancelRaf);

    const result = await createWorkerExecutionApp({
      canvas: {} as HTMLCanvasElement,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } } as never,
      capabilities,
      selection: {
        requestedTier: 'engine-worker',
        actualTier: 'engine-worker',
        selectionReason: 'explicit-request',
        missingCapabilities: [],
        sharedEvidencePassed: false,
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.start().ok).toBe(true);
    expect(raf).toHaveBeenCalledTimes(1);
    expect(result.value.pause().ok).toBe(true);
    expect(cancelRaf).toHaveBeenCalledTimes(1);

    expect(result.value.stop().ok).toBe(true);
    expect(probes.inputDetach).toHaveBeenCalledTimes(1);
    expect(probes.audioDispose).toHaveBeenCalledTimes(1);
    expect(probes.sessionDispose).toHaveBeenCalledTimes(1);
    expect(raf).toHaveBeenCalledTimes(1);
    expect(cancelRaf).toHaveBeenCalledTimes(1);

    const restart = result.value.start();
    expect(restart.ok).toBe(false);
    if (!restart.ok) expect(restart.error.code).toBe('app-not-started');
    expect(raf).toHaveBeenCalledTimes(1);
  });
});

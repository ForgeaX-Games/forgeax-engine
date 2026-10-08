import { createHostAudioConsumer } from '@forgeax/engine-audio-webaudio';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineToHostMessage } from '../execution/protocol';
import { workerSelection } from './execution-fixtures';

type SessionListener = (message: EngineToHostMessage) => void;

const probes = vi.hoisted(() => {
  const sessionListeners: SessionListener[] = [];
  return {
    audioDispose: vi.fn(),
    inputDetach: vi.fn(),
    sessionDispose: vi.fn(),
    sessionListen: vi.fn((listener: SessionListener) => {
      sessionListeners.push(listener);
      return () => {};
    }),
    sessionListeners,
    sessionPost: vi.fn(),
  };
});

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
    probes.sessionListeners.length = 0;
  });

  it('recreates the supplied Host audio owner on rebuild and disposes the old generation', async () => {
    const owners = Array.from({ length: 2 }, () => ({
      ...createHostAudioConsumer(),
      dispose: vi.fn(),
    }));
    const factory = vi.fn(() => {
      const owner = owners[factory.mock.calls.length - 1];
      if (!owner) throw new Error('unexpected Host generation');
      return owner;
    });
    const result = await createWorkerExecutionApp({
      canvas: {} as HTMLCanvasElement,
      appOptions: {
        execution: { bootstrap: 'https://example.test/game.js', createHostAudio: factory },
      },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    probes.sessionListeners[0]?.({
      kind: 'rebuilt',
      previousWorldIdentity: 'worker-world',
      worldIdentity: 'fresh-world',
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(owners[0]?.dispose).toHaveBeenCalledTimes(1);
    expect(result.value.execution.report().world.identity).toBe('fresh-world');
    await result.value.dispose();
    expect(owners[1]?.dispose).toHaveBeenCalledTimes(1);
  });

  it('returns a structured factory failure and releases the started Worker and input owner', async () => {
    const result = await createWorkerExecutionApp({
      canvas: {} as HTMLCanvasElement,
      appOptions: {
        execution: {
          bootstrap: 'https://example.test/game.js',
          createHostAudio: () => {
            throw new Error('effect factory failed');
          },
        },
      },
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'app-plugin-activation-failed' } });
    expect(probes.inputDetach).toHaveBeenCalledTimes(1);
    expect(probes.sessionDispose).toHaveBeenCalledTimes(1);
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
      selection: workerSelection({ render: false, kernels: false }),
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

  it('retains the existing terminal fault identity for host inspection', async () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 7),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const result = await createWorkerExecutionApp({
      canvas: {} as HTMLCanvasElement,
      appOptions: { execution: { bootstrap: 'https://example.test/game.js' } } as never,
      capabilities,
      selection: workerSelection({ render: false, kernels: false }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    let observed: unknown;
    result.value.onError((error) => {
      observed = error;
    });
    const listener = probes.sessionListeners[0];
    expect(listener).toBeTypeOf('function');

    listener?.({
      kind: 'fault',
      worldIdentity: 'worker-world',
      source: 'world',
      code: 'app-system-update-failed',
      expected: 'worker world update succeeds',
      hint: 'inspect the retained cause',
      detail: { cause: 'worker boom' },
      partialWrite: true,
      retryable: false,
    });

    expect(result.value.lastError).toBe(observed);
    expect(result.value.lastError).toMatchObject({
      code: 'app-system-update-failed',
      detail: { cause: { cause: 'worker boom' } },
    });
  });
});

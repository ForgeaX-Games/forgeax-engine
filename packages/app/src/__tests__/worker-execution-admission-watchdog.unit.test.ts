import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineToHostMessage, ExecutionFrameMessage } from '../execution/protocol';
import { workerSelection } from './execution-fixtures';

type SessionListener = (message: EngineToHostMessage) => void;

const probes = vi.hoisted(() => {
  const sessionListeners: SessionListener[] = [];
  return {
    audioDispose: vi.fn(),
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
  attachBrowserInputBackend: vi.fn(() =>
    Object.assign(() => {}, {
      backend: {
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
        detach: () => {},
      },
    }),
  ),
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

function makeRaf(): {
  readonly callbacks: Array<(timestamp: number) => void>;
  readonly raf: ReturnType<typeof vi.fn>;
} {
  const callbacks: Array<(timestamp: number) => void> = [];
  const raf = vi.fn((callback: (timestamp: number) => void) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  return { callbacks, raf };
}

async function createRunningApp(tier: 'engine-worker' | 'render-worker' = 'engine-worker') {
  const { callbacks, raf } = makeRaf();
  vi.stubGlobal('requestAnimationFrame', raf);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const result = await createWorkerExecutionApp({
    canvas: {} as HTMLCanvasElement,
    appOptions: { execution: { bootstrap: 'https://example.test/game.js' } } as never,
    capabilities,
    selection: workerSelection({ render: tier === 'render-worker', kernels: false }),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.start().ok).toBe(true);
  callbacks[0]?.(0);
  const frame = probes.sessionPost.mock.calls[0]?.[0] as ExecutionFrameMessage;
  expect(frame?.kind).toBe('frame');
  return { app: result.value, callbacks, frame };
}

function listener(): SessionListener {
  const value = probes.sessionListeners[0];
  if (value === undefined) throw new Error('Worker listener was not registered');
  return value;
}

function completeMessage(frame: ExecutionFrameMessage): EngineToHostMessage {
  return {
    kind: 'frame-complete',
    worldIdentity: frame.worldIdentity,
    frameId: frame.frameId,
    deviceGeneration: 1,
    presentation: 'ready',
    engineUpdateMs: 1,
    kernelWaitMs: 0,
  };
}

describe('Worker frame admission watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    probes.sessionListeners.length = 0;
  });

  it('admits N+1 but waits for N completion before N+2, without timing out render pacing', async () => {
    const { app, callbacks, frame } = await createRunningApp('render-worker');
    const emit = listener();
    emit({ ...completeMessage(frame), kind: 'simulation-complete' } as EngineToHostMessage);
    callbacks.at(-1)?.(16);
    const next = probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage;
    expect(next.frameId).toBe(2);
    emit({ ...completeMessage(next), kind: 'simulation-complete' } as EngineToHostMessage);
    callbacks.at(-1)?.(32);
    expect(
      probes.sessionPost.mock.calls.filter(([message]) => message.kind === 'frame'),
    ).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(3000);
    expect(app.lastError).toBeUndefined();
    emit({ kind: 'render-complete', epoch: 0, frame: completeMessage(frame) as never });
    expect(
      probes.sessionPost.mock.calls.filter(([message]) => message.kind === 'frame'),
    ).toHaveLength(2);
    emit({ kind: 'render-complete', epoch: 1, frame: completeMessage(frame) as never });
    callbacks.at(-1)?.(3048);
    expect(probes.sessionPost.mock.calls.at(-1)?.[0]).toMatchObject({ kind: 'frame', frameId: 3 });
    await app.dispose();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('preserves elapsed time when render completion wakes a still-running simulation frame', async () => {
    const { app, callbacks, frame } = await createRunningApp('render-worker');
    const emit = listener();
    emit({ ...completeMessage(frame), kind: 'simulation-complete' } as EngineToHostMessage);
    callbacks.at(-1)?.(16);
    const next = probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage;
    emit({ kind: 'render-complete', epoch: 1, frame: completeMessage(frame) as never });
    callbacks.at(-1)?.(32);
    expect(probes.sessionPost.mock.calls.at(-1)?.[0]).toBe(next);
    emit({ ...completeMessage(next), kind: 'simulation-complete' } as EngineToHostMessage);
    callbacks.at(-1)?.(48);
    expect(probes.sessionPost.mock.calls.at(-1)?.[0]).toMatchObject({
      kind: 'frame',
      frameId: 3,
      deltaSeconds: 0.032,
    });
    await app.dispose();
  });

  it('still reports a fatal frame timeout when the Worker never submits', async () => {
    const { app } = await createRunningApp();

    await vi.advanceTimersByTimeAsync(2_001);

    expect(app.execution.report().fault?.code).toBe('app-execution-deadline-exceeded');
    expect(app.lastError?.code).toBe('app-system-update-failed');
    expect(probes.sessionDispose).toHaveBeenCalledTimes(1);
  });

  it('clears only admission on submit and waits for the real completion before the next frame', async () => {
    const { app, callbacks, frame } = await createRunningApp();
    const onMessage = listener();

    onMessage({
      kind: 'frame-submitted',
      worldIdentity: frame.worldIdentity,
      frameId: frame.frameId,
      deviceGeneration: 1,
    });
    await vi.advanceTimersByTimeAsync(2_001);

    expect(app.lastError).toBeUndefined();
    expect(app.execution.report().frame).toMatchObject({
      submitted: 1,
      completed: 0,
      inFlight: 1,
    });
    expect(callbacks).toHaveLength(1);

    onMessage(completeMessage(frame));

    expect(app.lastError).toBeUndefined();
    expect(app.execution.report().frame).toMatchObject({
      submitted: 1,
      completed: 1,
      inFlight: 0,
    });
    expect(callbacks).toHaveLength(2);
  });

  it('keeps a rejected receipt fatal after submission', async () => {
    const { app, frame } = await createRunningApp();
    const onMessage = listener();
    onMessage({
      kind: 'frame-submitted',
      worldIdentity: frame.worldIdentity,
      frameId: frame.frameId,
      deviceGeneration: 1,
    });
    onMessage({
      kind: 'fault',
      worldIdentity: frame.worldIdentity,
      source: 'runtime',
      code: 'queue-submit-failed',
      expected: 'the frame receipt completes',
      hint: 'inspect the retained GPU error',
      detail: { cause: 'fence rejected' },
      partialWrite: false,
      retryable: false,
    });

    expect(app.execution.report().fault?.code).toBe('queue-submit-failed');
    expect(app.lastError?.code).toBe('app-system-update-failed');
    expect(probes.sessionDispose).toHaveBeenCalledTimes(1);
  });

  it('does not let a duplicate old submission clear the next frame watchdog', async () => {
    const { app, callbacks, frame } = await createRunningApp();
    const onMessage = listener();
    onMessage({
      kind: 'frame-submitted',
      worldIdentity: frame.worldIdentity,
      frameId: frame.frameId,
      deviceGeneration: 1,
    });
    onMessage(completeMessage(frame));
    callbacks[1]?.(16);
    const nextFrame = probes.sessionPost.mock.calls[1]?.[0] as ExecutionFrameMessage;
    expect(nextFrame.frameId).toBe(frame.frameId + 1);

    onMessage({
      kind: 'frame-submitted',
      worldIdentity: frame.worldIdentity,
      frameId: frame.frameId,
      deviceGeneration: 1,
    });
    await vi.advanceTimersByTimeAsync(2_001);

    expect(app.execution.report().fault?.code).toBe('app-execution-deadline-exceeded');
    expect(app.execution.report().frame).toMatchObject({
      submitted: 2,
      completed: 1,
      inFlight: 1,
    });
  });
});

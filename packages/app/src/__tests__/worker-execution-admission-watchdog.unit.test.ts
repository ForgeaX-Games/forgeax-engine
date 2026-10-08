import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EngineToHostMessage, ExecutionFrameMessage } from '../execution/protocol';
import { workerSelection } from './execution-fixtures';

type SessionListener = (message: EngineToHostMessage) => void;

const probes = vi.hoisted(() => {
  const sessionListeners: SessionListener[] = [];
  return {
    audioDispose: vi.fn(),
    browserCompleted: vi.fn(),
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

vi.mock('../browser-frame-signal', () => ({
  publishBrowserFrameCompleted: probes.browserCompleted,
  publishBrowserFrameSubmitted: vi.fn(),
  resetBrowserFrameSubmitted: vi.fn(),
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

  it('settles rejected-frame credit before a throwing error listener and admits a real retry', async () => {
    const { app, callbacks, frame } = await createRunningApp();
    const unsubscribe = app.onError(() => {
      throw new Error('listener fixture');
    });
    expect(() =>
      listener()({
        ...completeMessage(frame),
        kind: 'simulation-complete',
        renderRejection: {
          code: 'frame-submit-rejected',
          expected: 'no queue acceptance',
          hint: 'retry',
          detail: { operation: 'draw', stage: 'submit', accepted: false },
        },
      } as EngineToHostMessage),
    ).toThrow('listener fixture');
    unsubscribe();
    expect(app.execution.report().frame.completed).toBe(1); // Simulation credit, not a Render receipt.
    expect(probes.browserCompleted).not.toHaveBeenCalled();
    callbacks.at(-1)?.(16);
    const next = probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage;
    expect(next).toMatchObject({ kind: 'frame', frameId: 2 });
    listener()(completeMessage(next));
    expect(app.execution.report().frame.completed).toBe(2);
    expect(probes.browserCompleted).toHaveBeenCalledTimes(1);
    expect(probes.sessionDispose).not.toHaveBeenCalled();
    await app.dispose();
  });

  it('retains the resume reset through a rejected picture until a successful retry', async () => {
    const { app, callbacks, frame } = await createRunningApp();
    listener()(completeMessage(frame));
    app.pause().unwrap();
    app.resume().unwrap();
    callbacks.at(-1)?.(16);
    const rejected = probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage;
    expect(rejected.temporalReset).toBe(true);
    listener()({
      ...completeMessage(rejected),
      kind: 'simulation-complete',
      renderRejection: {
        code: 'frame-submit-rejected',
        expected: 'no queue acceptance',
        hint: 'retry',
        detail: { operation: 'draw', stage: 'submit', accepted: false },
      },
    } as EngineToHostMessage);
    callbacks.at(-1)?.(32);
    const retried = probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage;
    expect(retried.temporalReset).toBe(true);
    listener()(completeMessage(retried));
    callbacks.at(-1)?.(48);
    expect(
      (probes.sessionPost.mock.calls.at(-1)?.[0] as ExecutionFrameMessage).temporalReset,
    ).not.toBe(true);
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

describe('Worker inspection replies', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    probes.sessionListeners.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function inspect() {
    const { app } = await createRunningApp();
    const remoteEval = app.remoteEval;
    if (remoteEval === undefined) throw new Error('Worker App exposes remoteEval');
    const run = remoteEval('return 1', 'worker-world');
    const request = probes.sessionPost.mock.calls.at(-1)?.[0] as { readonly requestId: number };
    return { app, run, requestId: request.requestId, emit: listener() };
  }

  it('settles started and result from the same World', async () => {
    const { app, run, requestId, emit } = await inspect();
    emit({ kind: 'inspect-started', requestId, worldIdentity: 'worker-world' });
    await expect(run.started).resolves.toBeUndefined();
    emit({
      kind: 'inspect-result',
      requestId,
      worldIdentity: 'worker-world',
      result: { ok: true, value: 7 },
    });
    await expect(run).resolves.toBe(7);
    await app.dispose();
  });

  it('keeps an admitted cancel attached to the later result', async () => {
    const { app, run, requestId, emit } = await inspect();
    const cancelled = run.cancel();
    emit({ kind: 'inspect-canceled', requestId, worldIdentity: 'worker-world', admitted: true });
    await expect(cancelled).resolves.toBe(true);
    await expect(run.started).resolves.toBeUndefined();
    emit({
      kind: 'inspect-result',
      requestId,
      worldIdentity: 'worker-world',
      result: { ok: false, error: { code: 'live-eval-failed' } },
    });
    await expect(run).rejects.toMatchObject({ code: 'live-eval-failed' });
    await app.dispose();
  });

  it('rejects a cancel before admission without waiting for a result', async () => {
    const { app, run, requestId, emit } = await inspect();
    const cancelled = run.cancel();
    emit({ kind: 'inspect-canceled', requestId, worldIdentity: 'worker-world', admitted: false });
    await expect(cancelled).resolves.toBe(false);
    await expect(run).rejects.toMatchObject({ code: 'live-eval-cancelled-before-execution' });
    await expect(run.started).rejects.toMatchObject({
      code: 'live-eval-cancelled-before-execution',
    });
    await app.dispose();
  });

  it.each([
    'inspect-started',
    'inspect-canceled',
    'inspect-result',
  ] as const)('ends the request as stale when %s comes from another World', async (kind) => {
    const { app, run, requestId, emit } = await inspect();
    const cancelled = run.cancel();
    const base = { requestId, worldIdentity: 'rebuilt-world' };
    emit(
      kind === 'inspect-started'
        ? { kind, ...base }
        : kind === 'inspect-canceled'
          ? { kind, ...base, admitted: false }
          : { kind, ...base, result: { ok: true, value: 7 } },
    );
    await expect(cancelled).resolves.toBe(true);
    await expect(run).rejects.toMatchObject({ code: 'live-world-stale' });
    await expect(run.started).rejects.toMatchObject({ code: 'live-world-stale' });
    emit({
      kind: 'inspect-result',
      requestId,
      worldIdentity: 'worker-world',
      result: { ok: true, value: 7 },
    });
    await expect(run).rejects.toMatchObject({ code: 'live-world-stale' });
    await app.dispose();
  });
});

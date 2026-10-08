import type { RendererState } from '@forgeax/engine-render';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerSelection } from './execution-fixtures';

const mocks = vi.hoisted(() => {
  const renderer = {
    state: vi.fn((): RendererState => 'device-lost'),
    attach: vi.fn(() => ({ ok: true, value: {} })),
    draw: vi.fn(() => ({
      ok: true,
      value: {
        frameId: 1,
        deviceGeneration: 0,
        completed: true as true | Promise<{ ok: true; value: undefined }>,
      },
    })),
    releaseSurface: vi.fn(() => ({ ok: true, value: undefined })),
    restoreSurface: vi.fn(() => ({ ok: true, value: undefined })),
    dispose: vi.fn(async () => ({ ok: true, value: undefined })),
  };
  return {
    renderer,
    bootstrapGate: undefined as Promise<void> | undefined,
    bootstrapEntered: false,
  };
});

vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost: vi.fn(async () => ({
    ok: true,
    value: { renderer: mocks.renderer, assets: {}, featureHost: {} },
  })),
}));
vi.mock('../execution/bootstrap-entry', () => ({
  prepareBootstrapEntry: vi.fn(async () => {
    mocks.bootstrapEntered = true;
    await mocks.bootstrapGate;
    return { ok: true, value: { features: [], plugins: [] } };
  }),
  executionBootstrapHostPlugin: vi.fn(() => ({ name: 'bootstrap', inject: [], apply: () => {} })),
}));
vi.mock('../assets-runtime-assembly', () => ({
  createAssetRuntimeAssembly: vi.fn(() => ({
    ok: true,
    value: { registry: {}, dispose: vi.fn() },
  })),
}));
vi.mock('../renderer-plugin', () => ({ createRenderFeatureHost: vi.fn(() => ({})) }));
vi.mock('../execution/attached-world-swap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../execution/attached-world-swap')>()),
  commitAttachedWorld: vi.fn(async () => true),
}));
vi.mock('../internal/worker-engine-profile', () => ({ workerEngineProfile: vi.fn(() => ({})) }));
vi.mock('../execution/kernel-pool', () => ({
  createKernelPool: vi.fn(() => ({
    ready: async () => {},
    takeLastDispatch: () => undefined,
    dispose: () => {},
  })),
}));
vi.mock('@forgeax/engine-ecs', async (importOriginal) => {
  const original = await importOriginal<typeof import('@forgeax/engine-ecs')>();
  return {
    ...original,
    createWorldContext: vi.fn(async () => ({ fiber: { dispose: async () => {} } })),
  };
});

describe('M4 / m4_t1 — Engine Worker frame admission fences device loss', () => {
  let receive: (event: MessageEvent<unknown>) => void = () => {};
  let worldIdentity = '';
  let bootstrapMessages: unknown[] = [];
  let bootstrapDrawCalls = 0;

  beforeAll(async () => {
    globalThis.postMessage = vi.fn();
    await import('../execution/engine-worker-runtime');
    receive = globalThis.onmessage as unknown as (event: MessageEvent<unknown>) => void;
    let finish: () => void = () => {};
    mocks.bootstrapGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const canvas = { width: 1, height: 1 } as unknown as OffscreenCanvas;
    receive({
      data: {
        kind: 'init',
        canvas,
        bootstrapUrl: 'test://bootstrap',
        workers: workerSelection({ render: false, kernels: false }),
      },
    } as MessageEvent<unknown>);
    await vi.waitFor(() => expect(mocks.bootstrapEntered).toBe(true));

    receive({
      data: {
        kind: 'inspect',
        requestId: 100,
        worldIdentity: '',
        code: 'throw new Error("bootstrap must not execute");',
      },
    } as MessageEvent<unknown>);
    receive({
      data: { kind: 'inspect-cancel', requestId: 100, worldIdentity: '' },
    } as MessageEvent<unknown>);
    finish();
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'ready' }),
      ),
    );
    worldIdentity = (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([message]) => message)
      .find((message) => message.kind === 'ready').worldIdentity;
    bootstrapMessages = (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      ([message]) => message,
    );
    bootstrapDrawCalls = mocks.renderer.draw.mock.calls.length;
  });

  beforeEach(() => {
    mocks.renderer.state.mockReset();
    mocks.renderer.state.mockReturnValue('device-lost');
    mocks.renderer.attach.mockClear();
    mocks.renderer.draw.mockClear();
    mocks.bootstrapGate = undefined;
    mocks.bootstrapEntered = false;
    globalThis.postMessage = vi.fn();
  });

  function sendFrame(frameId = 1): void {
    receive({
      data: {
        kind: 'frame',
        worldIdentity,
        frameId,
        deltaSeconds: 1 / 60,
        inputSample: {
          downKeys: new Set(),
          upKeys: new Set(),
          buttons: [false, false, false],
          movementX: 0,
          movementY: 0,
          wheelDelta: 0,
          focused: true,
          pointerLocked: false,
        },
        canvasWidth: 1,
        canvasHeight: 1,
      },
    } as MessageEvent<unknown>);
  }

  function expectFrameAdmissionBlocked(state: Exclude<RendererState, 'alive'>): void {
    mocks.renderer.state.mockReturnValue(state);
    mocks.renderer.attach.mockClear();
    mocks.renderer.draw.mockClear();

    sendFrame();

    expect(mocks.renderer.attach).not.toHaveBeenCalled();
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
    expect(
      (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls.some(
        ([message]) => message.kind === 'frame-complete',
      ),
    ).toBe(false);
  }

  it('does not admit inspections before bootstrap finishes and allows queued cancellation', () => {
    expect(bootstrapMessages).toContainEqual({
      kind: 'inspect-canceled',
      requestId: 100,
      worldIdentity: '',
      admitted: false,
    });
    expect(bootstrapMessages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'inspect-started' })]),
    );
    expect(bootstrapMessages).toContainEqual(
      expect.objectContaining({ kind: 'ready', worldIdentity }),
    );
    expect(bootstrapDrawCalls).toBe(0);
  });

  it('does not update or post frame-complete while the renderer is device-lost', () => {
    expectFrameAdmissionBlocked('device-lost');
  });

  it('does not update or post frame-complete while the renderer is recovering', () => {
    expectFrameAdmissionBlocked('recovering');
  });

  it('does not update or post frame-complete while the renderer is faulted', () => {
    expectFrameAdmissionBlocked('faulted');
  });

  it('does not update or post frame-complete after the renderer is disposed', () => {
    expectFrameAdmissionBlocked('disposed');
  });

  it('answers a current World inspection without receiving another frame', async () => {
    mocks.renderer.state.mockReturnValue('alive');
    receive({
      data: { kind: 'inspect', requestId: 101, worldIdentity, code: 'return world.identity;' },
    } as MessageEvent<unknown>);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith({
        kind: 'inspect-result',
        requestId: 101,
        worldIdentity,
        result: { ok: true, value: worldIdentity },
      }),
    );
    expect(globalThis.postMessage).toHaveBeenCalledWith({
      kind: 'inspect-started',
      requestId: 101,
      worldIdentity,
    });
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
  });

  it('answers a stable World inspection while the submitted GPU receipt remains pending', async () => {
    mocks.renderer.state.mockReturnValue('alive');
    let finish: () => void = () => {};
    const completed = new Promise<{ ok: true; value: undefined }>((resolve) => {
      finish = () => resolve({ ok: true, value: undefined });
    });
    mocks.renderer.draw.mockReturnValueOnce({
      ok: true,
      value: { frameId: 1, deviceGeneration: 0, completed },
    });
    sendFrame();
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'frame-submitted', frameId: 1 }),
      ),
    );
    try {
      receive({
        data: { kind: 'inspect', requestId: 102, worldIdentity, code: 'return world.identity;' },
      } as MessageEvent<unknown>);
      await vi.waitFor(() =>
        expect(globalThis.postMessage).toHaveBeenCalledWith({
          kind: 'inspect-result',
          requestId: 102,
          worldIdentity,
          result: { ok: true, value: worldIdentity },
        }),
      );
      expect(mocks.renderer.draw).toHaveBeenCalledOnce();
      expect(
        (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls.some(
          ([message]) => message.kind === 'frame-complete',
        ),
      ).toBe(false);
    } finally {
      finish();
      await vi.waitFor(() =>
        expect(globalThis.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ kind: 'frame-complete', frameId: 1 }),
        ),
      );
    }
  });

  function inspect(requestId: number, code = 'return world.identity;'): void {
    receive({ data: { kind: 'inspect', requestId, worldIdentity, code } } as MessageEvent<unknown>);
  }

  it('can inspect a stable World after device loss without admitting a frame', async () => {
    inspect(103);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith({
        kind: 'inspect-result',
        requestId: 103,
        worldIdentity,
        result: { ok: true, value: worldIdentity },
      }),
    );
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
  });

  it('keeps an already admitted asynchronous inspection attached after cancellation', async () => {
    let finish: () => void = () => {};
    let entered = false;
    const barrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    Object.defineProperty(globalThis, '__workerInspectionBarrier', {
      configurable: true,
      value: {
        barrier,
        enter: () => {
          entered = true;
        },
      },
    });
    try {
      inspect(
        104,
        'globalThis.__workerInspectionBarrier.enter(); await globalThis.__workerInspectionBarrier.barrier; return world.identity;',
      );
      await vi.waitFor(() => expect(entered).toBe(true));
      receive({
        data: { kind: 'inspect-cancel', requestId: 104, worldIdentity },
      } as MessageEvent<unknown>);
      expect(globalThis.postMessage).toHaveBeenCalledWith({
        kind: 'inspect-canceled',
        requestId: 104,
        worldIdentity,
        admitted: true,
      });
      finish();
      await vi.waitFor(() =>
        expect(globalThis.postMessage).toHaveBeenCalledWith({
          kind: 'inspect-result',
          requestId: 104,
          worldIdentity,
          result: { ok: true, value: worldIdentity },
        }),
      );
    } finally {
      finish();
      Reflect.deleteProperty(globalThis, '__workerInspectionBarrier');
    }
  });

  it('fences evaluator import against rebuild and cancels requests queued during the transition', async () => {
    mocks.renderer.state.mockReturnValue('alive');
    let finish: () => void = () => {};
    mocks.bootstrapGate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const oldIdentity = worldIdentity;
    inspect(105, 'throw new Error("retired World must not execute");');
    // Even an already loaded evaluator yields at await before script execution.
    receive({ data: { kind: 'rebuild', worldIdentity } } as MessageEvent<unknown>);
    inspect(106);
    receive({
      data: { kind: 'inspect-cancel', requestId: 106, worldIdentity },
    } as MessageEvent<unknown>);
    expect(globalThis.postMessage).toHaveBeenCalledWith({
      kind: 'inspect-canceled',
      requestId: 106,
      worldIdentity,
      admitted: false,
    });
    expect(globalThis.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inspect-started', requestId: 106 }),
    );
    try {
      await vi.waitFor(() =>
        expect(globalThis.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: 'inspect-result',
            requestId: 105,
            result: { ok: false, error: expect.objectContaining({ code: 'live-world-stale' }) },
          }),
        ),
      );
      await vi.waitFor(() => expect(mocks.bootstrapEntered).toBe(true));
      inspect(109, 'throw new Error("queued retired World must not execute");');
    } finally {
      finish();
    }
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'rebuilt', previousWorldIdentity: oldIdentity }),
      ),
    );
    worldIdentity = (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls
      .map(([message]) => message)
      .find((message) => message.kind === 'rebuilt').worldIdentity;
    expect(worldIdentity).not.toBe(oldIdentity);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'inspect-result',
          requestId: 109,
          worldIdentity,
          result: {
            ok: false,
            error: expect.objectContaining({
              code: 'live-world-stale',
              detail: { expected: oldIdentity, actual: worldIdentity },
            }),
          },
        }),
      ),
    );
    expect(globalThis.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'inspect-started', requestId: 109 }),
    );
    inspect(107);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith({
        kind: 'inspect-result',
        requestId: 107,
        worldIdentity,
        result: { ok: true, value: worldIdentity },
      }),
    );
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
  });

  it('does not execute a script if disposal happens during evaluator import', async () => {
    globalThis.close = vi.fn();
    inspect(108, 'throw new Error("disposed World must not execute");');
    receive({ data: { kind: 'dispose' } } as MessageEvent<unknown>);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'inspect-result',
          requestId: 108,
          result: { ok: false, error: expect.objectContaining({ code: 'live-world-stale' }) },
        }),
      ),
    );
    await vi.waitFor(() => expect(globalThis.close).toHaveBeenCalledOnce());
    expect(mocks.renderer.draw).not.toHaveBeenCalled();
  });
});

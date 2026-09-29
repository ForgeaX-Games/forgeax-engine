import type { RendererState } from '@forgeax/engine-render';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { workerSelection } from './execution-fixtures';

const mocks = vi.hoisted(() => {
  const renderer = {
    state: vi.fn((): RendererState => 'device-lost'),
    attach: vi.fn(() => ({ ok: true, value: {} })),
    draw: vi.fn(() => ({ ok: true, value: { frameId: 1, deviceGeneration: 0, completed: true } })),
    releaseSurface: vi.fn(() => ({ ok: true, value: undefined })),
    restoreSurface: vi.fn(() => ({ ok: true, value: undefined })),
    dispose: vi.fn(async () => ({ ok: true, value: undefined })),
  };
  return { renderer };
});

vi.mock('@forgeax/engine-runtime/internal/renderer-host', () => ({
  constructRuntimeRendererHost: vi.fn(async () => ({
    ok: true,
    value: { renderer: mocks.renderer, assets: {}, featureHost: {} },
  })),
}));
vi.mock('../execution/bootstrap-entry', () => ({
  prepareBootstrapEntry: vi.fn(async () => ({ ok: true, value: { features: [], plugins: [] } })),
  executionBootstrapHostPlugin: vi.fn(() => ({ name: 'bootstrap', inject: [], apply: () => {} })),
}));
vi.mock('../assets-runtime-assembly', () => ({
  createAssetRuntimeAssembly: vi.fn(() => ({
    ok: true,
    value: { registry: {}, dispose: vi.fn() },
  })),
}));
vi.mock('../renderer-plugin', () => ({ createRenderFeatureHost: vi.fn(() => ({})) }));
vi.mock('../execution/attached-world-swap', () => ({
  commitAttachedWorld: vi.fn(async () => true),
  SerializedRebuildQueue: class {
    enqueue<T>(job: () => Promise<T>): Promise<T> {
      return job();
    }
  },
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

  beforeAll(async () => {
    globalThis.postMessage = vi.fn();
    await import('../execution/engine-worker-runtime');
    receive = globalThis.onmessage as unknown as (event: MessageEvent<unknown>) => void;
    const canvas = { width: 1, height: 1 } as unknown as OffscreenCanvas;
    receive({
      data: {
        kind: 'init',
        canvas,
        bootstrapUrl: 'test://bootstrap',
        workers: workerSelection({ render: false, kernels: false }),
      },
    } as MessageEvent<unknown>);
    await vi.waitFor(() =>
      expect(globalThis.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'ready' }),
      ),
    );
    worldIdentity = (
      (globalThis.postMessage as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as {
        worldIdentity: string;
      }
    ).worldIdentity;
  });

  beforeEach(() => {
    mocks.renderer.state.mockReset();
    mocks.renderer.state.mockReturnValue('device-lost');
    mocks.renderer.attach.mockClear();
    mocks.renderer.draw.mockClear();
    globalThis.postMessage = vi.fn();
  });

  function sendFrame(): void {
    receive({
      data: {
        kind: 'frame',
        worldIdentity,
        frameId: 1,
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
});

import { describe, expect, it } from 'vitest';
import {
  beginLearnRenderTestLifecycle,
  disposeLearnRenderTestApp,
  exposeLearnRenderTestApp,
  trackLearnRenderTestBootstrap,
  waitForLearnRenderTestBootstrap,
} from '../learn-render-test-lifecycle';
import { SUT_ATTRIBUTABLE_CODES } from '../onerror-gate';

const rendererReadyFailureCodes = [
  'manifest-malformed',
  'shader-not-found',
  'shader-compile-failed',
  'feature-not-enabled',
  'limit-exceeded',
  'webgpu-runtime-error',
] as const;

const rendererDrawFailureCodes = [
  'rhi-not-available',
  'webgpu-runtime-error',
  'render-system-empty-worlds',
  'render-system-owner-out-of-range',
  'render-system-no-camera',
  'render-system-multi-camera',
  'render-system-multi-light',
  'queue-submit-failed',
  'queue-write-buffer-out-of-bounds',
  'render-feature-registration-conflict',
  'render-feature-stage-failed',
  'render-feature-capability-missing',
  'render-feature-pass-order-conflict',
  'render-feature-preparation-failed',
  'render-feature-prepared-state-mismatch',
  'render-feature-draw-recording-failed',
] as const;

describe('SUT renderer error attribution', () => {
  it('attributes every documented Renderer.ready failure code', () => {
    for (const code of rendererReadyFailureCodes) {
      expect(SUT_ATTRIBUTABLE_CODES.has(code), code).toBe(true);
    }
  });

  it('attributes documented Renderer.draw and RenderFeature failures', () => {
    for (const code of rendererDrawFailureCodes) {
      expect(SUT_ATTRIBUTABLE_CODES.has(code), code).toBe(true);
    }
  });

  it('does not attribute environment lifecycle noise to the demo', () => {
    expect(SUT_ATTRIBUTABLE_CODES.has('device-lost')).toBe(false);
    expect(SUT_ATTRIBUTABLE_CODES.has('adapter-unavailable')).toBe(false);
  });
});

describe('SUT GPU lifecycle', () => {
  it('disposes and clears the registered app exactly once', async () => {
    let appDisposeCount = 0;
    let rendererDisposeCount = 0;
    const owner = {};
    await beginLearnRenderTestLifecycle(owner);
    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {
            rendererDisposeCount += 1;
          },
        },
        async dispose() {
          appDisposeCount += 1;
        },
      },
      owner,
    );

    await disposeLearnRenderTestApp(owner);
    await disposeLearnRenderTestApp(owner);

    expect(appDisposeCount).toBe(1);
    expect(rendererDisposeCount).toBe(1);
  });

  it('disposes a late app from a completed test instead of retaining it', async () => {
    let rendererDisposeCount = 0;
    const oldOwner = {};
    const currentOwner = {};
    await beginLearnRenderTestLifecycle(oldOwner);
    await disposeLearnRenderTestApp(oldOwner);
    await beginLearnRenderTestLifecycle(currentOwner);

    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {
            rendererDisposeCount += 1;
          },
        },
        async dispose() {},
      },
      oldOwner,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rendererDisposeCount).toBe(1);
    await disposeLearnRenderTestApp(currentOwner);
  });

  it('waits for stale disposal before allowing the next owner to start', async () => {
    let releaseDispose!: () => void;
    let disposalStarted = false;
    const oldOwner = {};
    const nextOwner = {};
    await beginLearnRenderTestLifecycle(oldOwner);
    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {},
        },
        dispose() {
          disposalStarted = true;
          return new Promise<void>((resolve) => {
            releaseDispose = resolve;
          });
        },
      },
      oldOwner,
    );

    const nextBegin = beginLearnRenderTestLifecycle(nextOwner);
    await Promise.resolve();
    expect(disposalStarted).toBe(true);
    let nextOwnerReady = false;
    void nextBegin.then(() => {
      nextOwnerReady = true;
    });
    await Promise.resolve();
    expect(nextOwnerReady).toBe(false);

    releaseDispose();
    await nextBegin;
    expect(nextOwnerReady).toBe(true);
    await disposeLearnRenderTestApp(nextOwner);
  });

  it('waits for a late old-owner disposal and propagates its failure', async () => {
    const oldOwner = {};
    const currentOwner = {};
    const nextOwner = {};
    const failure = new Error('late plugin cleanup failed');
    await beginLearnRenderTestLifecycle(oldOwner);
    await disposeLearnRenderTestApp(oldOwner);
    await beginLearnRenderTestLifecycle(currentOwner);

    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {},
        },
        async dispose() {
          return { ok: false, error: failure };
        },
      },
      oldOwner,
    );

    await expect(beginLearnRenderTestLifecycle(nextOwner)).rejects.toBe(failure);
    await disposeLearnRenderTestApp(nextOwner);
  });

  it('waits for the tracked bootstrap before admitting the next owner', async () => {
    let releaseBootstrap!: () => void;
    let releaseAppDispose!: () => void;
    const oldOwner = {};
    const nextOwner = {};
    await beginLearnRenderTestLifecycle(oldOwner);

    const lateApp = {
      renderer: {
        dispose() {},
      },
      dispose() {
        return new Promise<void>((resolve) => {
          releaseAppDispose = resolve;
        });
      },
    };
    const bootstrap = new Promise<void>((resolve) => {
      releaseBootstrap = () => {
        exposeLearnRenderTestApp(lateApp, oldOwner);
        resolve();
      };
    });
    trackLearnRenderTestBootstrap(bootstrap, oldOwner);

    const nextBegin = beginLearnRenderTestLifecycle(nextOwner);
    await Promise.resolve();
    let nextOwnerReady = false;
    void nextBegin.then(() => {
      nextOwnerReady = true;
    });
    await Promise.resolve();
    expect(nextOwnerReady).toBe(false);

    releaseBootstrap();
    await Promise.resolve();
    expect(nextOwnerReady).toBe(false);
    releaseAppDispose();
    await nextBegin;
    expect(nextOwnerReady).toBe(true);
    await disposeLearnRenderTestApp(nextOwner);
  });

  it('waits for a tracked bootstrap before disposing the current app', async () => {
    let releaseBootstrap!: () => void;
    let appDisposeCount = 0;
    let rendererDisposeCount = 0;
    const owner = {};
    await beginLearnRenderTestLifecycle(owner);

    const bootstrap = new Promise<void>((resolve) => {
      releaseBootstrap = resolve;
    });
    trackLearnRenderTestBootstrap(bootstrap, owner);
    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {
            rendererDisposeCount += 1;
          },
        },
        async dispose() {
          appDisposeCount += 1;
        },
      },
      owner,
    );

    let waitDone = false;
    const waiting = waitForLearnRenderTestBootstrap(owner).then(() => {
      waitDone = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(waitDone).toBe(false);
    expect(appDisposeCount).toBe(0);
    expect(rendererDisposeCount).toBe(0);

    releaseBootstrap();
    await waiting;
    expect(appDisposeCount).toBe(0);
    expect(rendererDisposeCount).toBe(0);

    await disposeLearnRenderTestApp(owner);
    expect(appDisposeCount).toBe(1);
    expect(rendererDisposeCount).toBe(1);
    await disposeLearnRenderTestApp(owner);
    expect(appDisposeCount).toBe(1);
    expect(rendererDisposeCount).toBe(1);
  });

  it('propagates a tracked bootstrap rejection through the wait API', async () => {
    const owner = {};
    const failure = new Error('bootstrap wait failed');
    await beginLearnRenderTestLifecycle(owner);
    trackLearnRenderTestBootstrap(Promise.reject(failure), owner);

    await expect(waitForLearnRenderTestBootstrap(owner)).rejects.toBe(failure);
    await disposeLearnRenderTestApp(owner);
  });

  it('fails the final teardown when a tracked bootstrap rejects', async () => {
    const owner = {};
    const failure = new Error('bootstrap cleanup failed');
    await beginLearnRenderTestLifecycle(owner);
    trackLearnRenderTestBootstrap(Promise.reject(failure), owner);

    await expect(disposeLearnRenderTestApp(owner)).rejects.toBe(failure);
    await disposeLearnRenderTestApp(owner);
  });

  it('fails closed on an App disposal Result.err while releasing the renderer', async () => {
    let rendererDisposeCount = 0;
    const owner = {};
    const failure = new Error('plugin cleanup failed');
    await beginLearnRenderTestLifecycle(owner);
    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {
            rendererDisposeCount += 1;
          },
        },
        async dispose() {
          return { ok: false, error: failure };
        },
      },
      owner,
    );

    await expect(disposeLearnRenderTestApp(owner)).rejects.toBe(failure);
    expect(rendererDisposeCount).toBe(1);
    await disposeLearnRenderTestApp(owner);
  });

  it('fails closed when App disposal rejects with undefined', async () => {
    let rendererDisposeCount = 0;
    const owner = {};
    await beginLearnRenderTestLifecycle(owner);
    exposeLearnRenderTestApp(
      {
        renderer: {
          dispose() {
            rendererDisposeCount += 1;
          },
        },
        async dispose() {
          throw undefined;
        },
      },
      owner,
    );

    await expect(disposeLearnRenderTestApp(owner)).rejects.toBeUndefined();
    expect(rendererDisposeCount).toBe(1);
    await disposeLearnRenderTestApp(owner);
  });
});

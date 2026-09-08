import type { EncodedTape, RecorderAttachment, RhiDebugError } from '@forgeax/engine-rhi-debug';
import { ok, type Result } from '@forgeax/engine-types';
import { describe, expect, it, vi } from 'vitest';
import { bindRhiCaptureFrameDriver, createRhiCapture } from '../internal/rhi-capture';

const encoded: EncodedTape = {
  bytes: new Uint8Array([82, 72, 73, 84, 65, 80, 69]),
  digest: 'sha256:host-contract',
  tape: {
    header: { formatVersion: 7, rhiCaps: {}, eventCount: 0, blobCount: 0 },
    bootstrap: [],
    events: [],
    blobs: [],
  },
};

function attachment(): RecorderAttachment {
  return {
    backend: {} as RecorderAttachment['backend'],
    captureFrame: async () => ok(encoded),
    frameBoundary: async () => ok(undefined),
    deviceLost: () => undefined,
    dispose: async () => ok(undefined),
  };
}

function deferredAttachment(): {
  readonly attachment: RecorderAttachment;
  readonly releaseSnapshot: () => void;
} {
  let releaseSnapshot!: () => void;
  const snapshotReleased = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let resolveCapture!: (result: Result<EncodedTape, RhiDebugError>) => void;
  let boundaryCount = 0;
  const deferred: RecorderAttachment = {
    backend: {} as RecorderAttachment['backend'],
    captureFrame: () =>
      new Promise((resolve) => {
        resolveCapture = resolve;
      }),
    frameBoundary: async () => {
      boundaryCount += 1;
      if (boundaryCount === 1) {
        await snapshotReleased;
        return ok(undefined);
      }
      resolveCapture(ok(encoded));
      return ok(undefined);
    },
    deviceLost: () => undefined,
    dispose: async () => ok(undefined),
  };
  return { attachment: deferred, releaseSnapshot };
}

function driverFor(
  attachment: RecorderAttachment,
  initialState: 'running' | 'paused',
): {
  readonly driver: Parameters<typeof bindRhiCaptureFrameDriver>[1];
  readonly pause: ReturnType<typeof vi.fn>;
  readonly resume: ReturnType<typeof vi.fn>;
  readonly stepFrame: ReturnType<typeof vi.fn>;
} {
  let state = initialState;
  const pause = vi.fn(() => {
    state = 'paused';
    return ok(undefined);
  });
  const resume = vi.fn(() => {
    state = 'running';
    return ok(undefined);
  });
  const stepFrame = vi.fn((_deltaSeconds: number) => {
    void attachment.frameBoundary();
    return ok(undefined);
  });
  return {
    driver: {
      getState: () => state,
      pause,
      resume,
      stepFrame,
    },
    pause,
    resume,
    stepFrame,
  };
}

describe('RHI capture host capability', () => {
  it('uses one typed capability for main and worker host handoff', async () => {
    const main = createRhiCapture(attachment());
    const worker = main;

    const [mainResult, workerResult] = await Promise.all([
      main.captureFrame(),
      worker.captureFrame(),
    ]);

    expect(mainResult).toEqual({
      ok: true,
      value: {
        kind: 'rhi-tape',
        digest: encoded.digest,
        bytes: encoded.bytes,
      },
    });
    expect(workerResult).toEqual(mainResult);
  });

  it('owns one App frame transaction and resumes a previously running loop', async () => {
    const deferred = deferredAttachment();
    const capture = createRhiCapture(deferred.attachment);
    const driver = driverFor(deferred.attachment, 'running');
    bindRhiCaptureFrameDriver(capture, driver.driver);

    const pending = capture.captureFrame();
    await Promise.resolve();

    expect(driver.pause).toHaveBeenCalledTimes(1);
    expect(driver.stepFrame).not.toHaveBeenCalled();

    deferred.releaseSnapshot();
    const result = await pending;

    expect(result).toEqual({
      ok: true,
      value: {
        kind: 'rhi-tape',
        digest: encoded.digest,
        bytes: encoded.bytes,
      },
    });
    expect(driver.stepFrame).toHaveBeenCalledWith(0);
    expect(driver.stepFrame).toHaveBeenCalledTimes(1);
    expect(driver.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps a previously paused loop paused while capture advances one frame', async () => {
    const deferred = deferredAttachment();
    const capture = createRhiCapture(deferred.attachment);
    const driver = driverFor(deferred.attachment, 'paused');
    bindRhiCaptureFrameDriver(capture, driver.driver);

    const pending = capture.captureFrame();
    await Promise.resolve();
    expect(driver.pause).not.toHaveBeenCalled();

    deferred.releaseSnapshot();
    expect((await pending).ok).toBe(true);
    expect(driver.stepFrame).toHaveBeenCalledWith(0);
    expect(driver.resume).not.toHaveBeenCalled();
  });
});

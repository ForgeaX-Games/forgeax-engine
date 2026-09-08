import type { RhiBackendInstrumentation } from '@forgeax/engine-render/internal/construct-renderer';
import { RhiError } from '@forgeax/engine-rhi';
import type {
  CaptureFrameOptions,
  EncodedTape,
  RecorderAttachment,
  RhiDebugError,
} from '@forgeax/engine-rhi-debug';
import { createRhiDebugError } from '@forgeax/engine-rhi-debug';
import { err, ok, type Result } from '@forgeax/engine-types';
import type { FrameLoopHandle } from './frame-loop';

export interface RhiTapeArtifactRef {
  readonly kind: 'rhi-tape';
  readonly digest: string;
  readonly bytes: Uint8Array;
}

export interface RhiCapture {
  captureFrame(options?: CaptureFrameOptions): Promise<Result<RhiTapeArtifactRef, RhiDebugError>>;
}

type CaptureResult = Result<EncodedTape, RhiDebugError>;
type CaptureFrameDriver = Pick<FrameLoopHandle, 'getState' | 'pause' | 'resume' | 'stepFrame'>;

const captureDrivers = new WeakMap<RhiCapture, CaptureFrameDriver>();

export function createRhiCapture(attachment: RecorderAttachment): RhiCapture {
  let activeCapture: Promise<Result<RhiTapeArtifactRef, RhiDebugError>> | undefined;
  const capture: RhiCapture = {
    captureFrame(options) {
      const driver = captureDrivers.get(capture);
      if (driver === undefined) return captureAttachment(attachment, options);
      if (activeCapture !== undefined) {
        return Promise.resolve(
          err(
            createRhiDebugError('capture-busy', {
              stage: 'capture',
              cause: 'another App capture transaction is active',
            }),
          ),
        );
      }
      const request = captureWithAppFrame(attachment, driver, options);
      activeCapture = request;
      void request.then(
        () => {
          if (activeCapture === request) activeCapture = undefined;
        },
        () => {
          if (activeCapture === request) activeCapture = undefined;
        },
      );
      return request;
    },
  };
  return capture;
}

/** Bind the App-owned frame authority to its host capture capability. */
export function bindRhiCaptureFrameDriver(capture: RhiCapture, driver: CaptureFrameDriver): void {
  captureDrivers.set(capture, driver);
}

async function captureAttachment(
  attachment: RecorderAttachment,
  options: CaptureFrameOptions | undefined,
): Promise<Result<RhiTapeArtifactRef, RhiDebugError>> {
  const result = await attachment.captureFrame(options);
  if (!result.ok) return result;
  return ok(toArtifact(result.value));
}

async function captureWithAppFrame(
  attachment: RecorderAttachment,
  driver: CaptureFrameDriver,
  options: CaptureFrameOptions | undefined,
): Promise<Result<RhiTapeArtifactRef, RhiDebugError>> {
  const state = driver.getState();
  if (state !== 'running' && state !== 'paused') {
    return err(
      createRhiDebugError('capture-unavailable', {
        stage: 'capture',
        cause: `App capture requires a running or paused frame loop, received '${state}'`,
      }),
    );
  }
  if (options?.signal?.aborted) return captureAttachment(attachment, options);

  const resumeAfter = state === 'running';
  if (resumeAfter) {
    const paused = driver.pause();
    if (!paused.ok) {
      return err(
        createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: `App capture could not pause the frame loop: ${describeFailure(paused.error)}`,
        }),
      );
    }
  }

  const controller = new AbortController();
  const abortFromUser = (): void => controller.abort();
  options?.signal?.addEventListener('abort', abortFromUser, { once: true });
  let captureResult: Promise<CaptureResult>;
  try {
    captureResult = attachment.captureFrame({
      ...(options ?? {}),
      signal: controller.signal,
    });
  } catch (cause: unknown) {
    options?.signal?.removeEventListener('abort', abortFromUser);
    if (resumeAfter && driver.getState() === 'paused') driver.resume();
    return err(
      createRhiDebugError('capture-unavailable', {
        stage: 'capture',
        cause: `App capture could not arm the recorder: ${describeFailure(cause)}`,
      }),
    );
  }

  let result: CaptureResult | undefined;
  let transactionError: RhiDebugError | undefined;
  try {
    const snapshot = await attachment.frameBoundary();
    if (!snapshot.ok) {
      result = await captureResult;
    } else if (options?.signal?.aborted) {
      controller.abort();
      result = await captureResult;
    } else {
      const stepped = driver.stepFrame(0);
      if (!stepped.ok) {
        transactionError = createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: `App capture frame failed: ${describeFailure(stepped.error)}`,
        });
        controller.abort();
        result = await captureResult;
      } else {
        result = await captureResult;
      }
    }
  } catch (cause: unknown) {
    transactionError = createRhiDebugError('capture-unavailable', {
      stage: 'capture',
      cause: `App capture transaction failed: ${describeFailure(cause)}`,
    });
    controller.abort();
    result = await captureResult;
  } finally {
    options?.signal?.removeEventListener('abort', abortFromUser);
    if (resumeAfter && driver.getState() === 'paused') {
      const resumed = driver.resume();
      if (!resumed.ok && transactionError === undefined) {
        transactionError = createRhiDebugError('capture-unavailable', {
          stage: 'capture',
          cause: `App capture could not resume the frame loop: ${describeFailure(resumed.error)}`,
        });
      }
    }
  }

  if (transactionError !== undefined) return err(transactionError);
  if (result === undefined) result = await captureResult;
  if (!result.ok) return result;
  return ok(toArtifact(result.value));
}

function describeFailure(cause: unknown): string {
  if (typeof cause === 'string') return cause;
  if (cause instanceof Error) return cause.message;
  if (typeof cause === 'object' && cause !== null && 'hint' in cause) {
    const hint = (cause as { hint?: unknown }).hint;
    if (typeof hint === 'string') return hint;
  }
  return String(cause);
}

export function createRhiInstrumentation(
  attachment: RecorderAttachment,
): RhiBackendInstrumentation {
  return {
    resolveSurfaceDevice(device) {
      const resolved = attachment.backend.unwrapDeviceForSurface(device);
      if (resolved.ok) return resolved;
      return err(
        new RhiError({
          code: 'rhi-not-available',
          expected: 'the recorder can resolve the wrapped surface device',
          hint: resolved.error.hint,
        }),
      );
    },
    onFrameBoundary() {
      void attachment.frameBoundary();
    },
    onDeviceLost() {
      attachment.deviceLost();
    },
  };
}

function toArtifact(encoded: EncodedTape): RhiTapeArtifactRef {
  return {
    kind: 'rhi-tape',
    digest: encoded.digest,
    bytes: encoded.bytes,
  };
}

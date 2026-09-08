import { describe, expect, it } from 'vitest';
import type { InputBackendSample } from '@forgeax/engine-input';
import { measureCanvasDrawingBuffer } from '../src/create-app';
import { startEngineWorker } from '../src/execution/engine-worker';
import type { ExecutionFrameMessage } from '../src/execution/protocol';

function waitForAspect(port: MessagePort, expected: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      port.removeEventListener('message', onMessage);
      reject(new Error(`worker did not report aspect ${expected}`));
    }, 5_000);
    const onMessage = (event: MessageEvent<{ kind?: string; aspect?: number }>): void => {
      if (event.data.kind !== 'camera-aspect') return;
      if (Math.abs((event.data.aspect ?? 0) - expected) > 1e-4) return;
      window.clearTimeout(timeout);
      port.removeEventListener('message', onMessage);
      resolve();
    };
    port.addEventListener('message', onMessage);
    port.start();
  });
}

describe('Engine Worker canvas resize', () => {
  it('transports CSS resize to the OffscreenCanvas and camera aspect', async () => {
    if (
      typeof Worker === 'undefined' ||
      typeof OffscreenCanvas === 'undefined' ||
      navigator.gpu === undefined
    )
      return;

    const canvas = document.createElement('canvas');
    canvas.style.width = '320px';
    canvas.style.height = '180px';
    document.body.appendChild(canvas);
    const channel = new MessageChannel();
    const started = await startEngineWorker({
      canvas,
      bootstrapUrl: new URL('./worker-resize-bootstrap.ts', import.meta.url).href,
      bootstrapPort: channel.port2,
      timeoutMs: 10_000,
      tier: 'engine-worker',
      workerFactory: () =>
        new Worker(new URL('../src/execution/engine-worker-runtime.ts', import.meta.url), {
          type: 'module',
          name: 'forgeax-resize-test',
        }),
    });
    const startupDetail = started.ok ? undefined : started.error.detail;
    const startupCause = startupDetail?.cause as { name?: string; message?: string } | undefined;
    expect(
      started.ok,
      started.ok
        ? undefined
        : `${started.error.code}: ${started.error.hint}; phase=${startupDetail?.phase}; cause=${startupCause?.name ?? 'unknown'}:${startupCause?.message ?? JSON.stringify(startupCause)}`,
    ).toBe(true);
    if (!started.ok) {
      channel.port1.close();
      canvas.remove();
      return;
    }
    const session = started.value;
    const sample: InputBackendSample = {
      downKeys: new Set(),
      upKeys: new Set(),
      buttons: [false, false, false],
      movementX: 0,
      movementY: 0,
      wheelDelta: 0,
      focused: true,
      pointerLocked: false,
    };
    const sendFrame = (frameId: number): void => {
      const size = measureCanvasDrawingBuffer(canvas, 1);
      const frame = {
        kind: 'frame' as const,
        worldIdentity: session.ready.worldIdentity,
        frameId,
        deltaSeconds: 1 / 60,
        inputSample: sample,
        canvasWidth: size.width,
        canvasHeight: size.height,
      } satisfies ExecutionFrameMessage;
      session.post(frame);
    };
    channel.port1.start();
    try {
      sendFrame(1);
      await waitForAspect(channel.port1, 320 / 180);

      canvas.style.width = '400px';
      canvas.style.height = '200px';
      sendFrame(2);
      await waitForAspect(channel.port1, 2);
    } finally {
      session.dispose();
      channel.port1.close();
      canvas.remove();
    }
  });
});

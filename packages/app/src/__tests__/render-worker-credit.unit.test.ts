import { AssetRegistry } from '@forgeax/engine-assets-runtime';
import { World } from '@forgeax/engine-ecs';
import { ShaderRegistry } from '@forgeax/engine-shader';
import { afterEach, expect, it, vi } from 'vitest';
import type { ExecutionFrameMessage, ExecutionInitMessage } from '../execution/protocol';
import type { RenderWorkerInput, RenderWorkerOutput } from '../execution/render-worker-protocol';
import { SourceRenderWorker } from '../execution/source-render-worker';
import { workerSelection } from './execution-fixtures';

class CreditWorker {
  static current: CreditWorker;
  listeners = new Set<(event: MessageEvent<RenderWorkerOutput>) => void>();
  addEventListener(_kind: string, listener: (event: MessageEvent<RenderWorkerOutput>) => void) {
    this.listeners.add(listener);
  }
  removeEventListener(_kind: string, listener: (event: MessageEvent<RenderWorkerOutput>) => void) {
    this.listeners.delete(listener);
  }
  onmessage?: (event: MessageEvent<RenderWorkerOutput>) => void;
  packets: Extract<RenderWorkerInput, { kind: 'draw' }>[] = [];
  controls: RenderWorkerInput[] = [];
  init?: Extract<RenderWorkerInput, { kind: 'init' }>;
  constructor() {
    CreditWorker.current = this;
  }
  emit(data: unknown) {
    for (const listener of this.listeners)
      listener(
        new MessageEvent<RenderWorkerOutput>('message', { data: data as RenderWorkerOutput }),
      );
    this.onmessage?.(
      new MessageEvent<RenderWorkerOutput>('message', { data: data as RenderWorkerOutput }),
    );
  }
  postMessage(message: RenderWorkerInput, transfer: Transferable[] = []) {
    if (message.kind === 'init') {
      this.init = message;
      queueMicrotask(() =>
        this.emit({ kind: 'ready', capabilities: { backendKind: 'webgpu', storageBuffer: true } }),
      );
    } else if (message.kind === 'draw') this.packets.push(structuredClone(message, { transfer }));
    else if (message.kind === 'dispose') queueMicrotask(() => this.emit({ kind: 'disposed' }));
    else this.controls.push(message);
  }
  terminate() {}
}
afterEach(() => vi.unstubAllGlobals());
it('seals two consecutive frames and rejects a third until the oldest completes', async () => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const canvas = {} as OffscreenCanvas;
  const init: ExecutionInitMessage = {
    kind: 'init',
    startupTimeoutMs: 90_000,
    canvas,
    bootstrapUrl: '',
    workers: workerSelection({ engine: true, render: true, kernels: false }),
  };
  const source = new SourceRenderWorker(world, assets, init, () => {});
  await source.start(canvas);
  const frame: ExecutionFrameMessage = {
    kind: 'frame',
    worldIdentity: world.identity,
    frameId: 1,
    deltaSeconds: 0,
    canvasWidth: 32,
    canvasHeight: 32,
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
  };
  const worker = CreditWorker.current;
  const complete = () => {
    const draw = worker.packets.shift();
    if (draw === undefined) throw new Error('No publication');
    const p = draw.publication;
    const buffers = [
      p.upserts.buffer,
      p.removed.buffer,
      p.transformEntities.buffer,
      p.transforms.buffer,
    ];
    worker.emit({
      kind: 'completed',
      revision: p.revision,
      buffers,
      frame: {
        kind: 'frame-complete',
        worldIdentity: world.identity,
        frameId: draw.frameId,
        engineUpdateMs: 0,
        kernelWaitMs: 0,
      },
    });
  };
  try {
    source.publish(frame, 0);
    source.publish({ ...frame, frameId: 2, temporalReset: true }, 1);
    expect(worker.packets.map((packet) => packet.frameId)).toEqual([1, 2]);
    expect(worker.packets[1]?.publication.temporalReset).toBe(true);
    expect(() => source.publish({ ...frame, frameId: 3 }, 2)).toThrow();
    complete();
    source.publish({ ...frame, frameId: 3 }, 2);
    expect(worker.packets.map((packet) => packet.frameId)).toEqual([2, 3]);
    expect(worker.packets[1]?.publication.temporalReset).toBe(false);
    complete();
    source.publish({ ...frame, frameId: 4 }, 3);
    expect(worker.packets[1]?.publication.temporalReset).toBe(false);
  } finally {
    await source.dispose();
  }
});

it('forwards timing options to the child and retains the latest completed observation', async () => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const canvas = {} as OffscreenCanvas;
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      startupTimeoutMs: 90_000,
      canvas,
      bootstrapUrl: '',
      workers: workerSelection({ engine: true, render: true, kernels: false }),
      diagnostics: { gpuPassTiming: { retentionFrames: 4 } },
    },
    () => {},
  );
  await source.start(canvas);
  const worker = CreditWorker.current;
  expect(worker.init?.gpuPassTiming).toEqual({ retentionFrames: 4 });
  source.publish(
    {
      kind: 'frame',
      worldIdentity: world.identity,
      frameId: 7,
      deltaSeconds: 0,
      canvasWidth: 32,
      canvasHeight: 32,
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
    },
    0,
  );
  const draw = worker.packets.shift();
  if (draw === undefined) throw new Error('No timing publication');
  const publication = draw.publication;
  const observation = {
    status: 'unavailable',
    reason: { code: 'timestamp-query-unsupported' },
    capability: { timestampQuery: false, timestampPeriodNanoseconds: null },
  } as const;
  worker.emit({
    kind: 'completed',
    revision: publication.revision,
    buffers: [
      publication.upserts.buffer,
      publication.removed.buffer,
      publication.transformEntities.buffer,
      publication.transforms.buffer,
    ],
    gpuPassTiming: observation,
    frame: {
      kind: 'frame-complete',
      worldIdentity: world.identity,
      frameId: 7,
      engineUpdateMs: 0,
      kernelWaitMs: 0,
    },
  });
  expect(source.inspectGpuPassTiming()).toEqual({ frameId: 7, observation });
  await source.dispose();
});

it('routes capture results once, cancels the remote request, and settles it on render loss', async () => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const canvas = {} as OffscreenCanvas;
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      startupTimeoutMs: 90_000,
      canvas,
      bootstrapUrl: '',
      workers: workerSelection({ engine: true, render: true, kernels: false }),
      diagnostics: { rhiCapture: true },
    },
    () => {},
  );
  await source.start(canvas);
  const worker = CreditWorker.current;
  try {
    const first = source.captureFrame();
    expect((await source.captureFrame()).ok).toBe(false);
    const request = worker.controls.at(-1);
    if (request?.kind !== 'capture') throw new Error('Capture was not sent');
    const artifact = { kind: 'rhi-tape', bytes: new Uint8Array([1, 2, 3]) };
    worker.emit({
      kind: 'capture-result',
      requestId: request.requestId + 1,
      result: { ok: true, value: artifact },
    });
    expect((await source.captureFrame()).ok).toBe(false);
    worker.emit({
      kind: 'capture-result',
      requestId: request.requestId,
      result: { ok: true, value: artifact },
    });
    const received = (await first).unwrap();
    expect(received).toMatchObject({ kind: 'rhi-tape', byteLength: 3, bytes: artifact.bytes });
    expect([...received.chunks(2)].map((chunk) => [...chunk.bytes])).toEqual([[1, 2], [3]]);
    const controller = new AbortController();
    const cancelled = source.captureFrame({ signal: controller.signal });
    controller.abort();
    expect((await cancelled).ok).toBe(false);
    expect(worker.controls.at(-1)?.kind).toBe('capture-cancel');
    const lost = source.captureFrame();
    worker.emit({
      kind: 'failed',
      error: {
        code: 'device-lost',
        expected: 'alive',
        hint: 'replace',
        detail: 'device lost during capture',
      },
      stage: 'draw',
      recoverable: true,
    });
    expect((await lost).ok).toBe(false);
  } finally {
    await source.dispose();
  }
});

it('uses the App startup budget for child initialization and still bounds a stalled child', async () => {
  class DelayedReadyWorker extends CreditWorker {
    override postMessage(message: RenderWorkerInput, transfer: Transferable[] = []) {
      if (message.kind !== 'init') super.postMessage(message, transfer);
    }
  }
  vi.useFakeTimers();
  vi.stubGlobal('Worker', DelayedReadyWorker);
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const canvas = {} as OffscreenCanvas;
  const init = {
    kind: 'init',
    canvas,
    bootstrapUrl: '',
    workers: workerSelection({ engine: true, render: true, kernels: false }),
    startupTimeoutMs: 90_000,
  } as const;
  const source = new SourceRenderWorker(world, assets, init, () => {});
  let settled = false;
  const starting = source.start(canvas).then(
    () => {
      settled = true;
      return 'ready';
    },
    (error) => {
      settled = true;
      return String(error);
    },
  );
  try {
    await vi.advanceTimersByTimeAsync(40_000);
    expect(settled).toBe(false);
    CreditWorker.current.emit({
      kind: 'ready',
      capabilities: { backendKind: 'webgpu', storageBuffer: true },
    });
    expect(await starting).toBe('ready');
    await source.dispose();
    const next = new SourceRenderWorker(world, assets, init, () => {});
    const failure = next.start(canvas).catch((error) => String(error));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(await failure).toContain('initialization timed out');
    await next.dispose();
  } finally {
    await source.dispose();
    vi.useRealTimers();
  }
});

it('reads remote bounds without advancing a frame and retires pending reads on disposal', async () => {
  vi.stubGlobal('Worker', CreditWorker);
  const world = new World();
  const assets = new AssetRegistry(new ShaderRegistry({ manifestUrl: undefined }));
  const canvas = {} as OffscreenCanvas;
  const source = new SourceRenderWorker(
    world,
    assets,
    {
      kind: 'init',
      startupTimeoutMs: 90_000,
      canvas,
      bootstrapUrl: '',
      workers: workerSelection({ engine: true, render: true, kernels: false }),
    },
    () => {},
  );
  await source.start(canvas);
  const worker = CreditWorker.current;
  try {
    const read = source.bounds(7);
    const request = worker.controls.at(-1);
    if (request?.kind !== 'bounds') throw new Error('missing bounds request');
    const bounds = { min: [1, 2, 3], max: [4, 5, 6] };
    worker.emit({ kind: 'bounds-result', requestId: request.requestId, bounds });
    expect(await read).toEqual(bounds);
    expect(worker.packets).toHaveLength(0);
    const pending = expect(source.bounds(8)).rejects.toThrow('session ended');
    await source.dispose();
    await pending;
    worker.emit({ kind: 'bounds-result', requestId: request.requestId, bounds });
  } finally {
    await source.dispose();
  }
});

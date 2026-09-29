import { describe, expect, it, vi } from 'vitest';
import { startEngineWorker } from '../execution/engine-worker';
import type { EngineToHostMessage, HostToEngineMessage } from '../execution/protocol';
import { workerSelection } from './execution-fixtures';

class FakeWorker extends EventTarget {
  onmessage: ((event: MessageEvent<EngineToHostMessage>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posts: Array<{
    readonly message: HostToEngineMessage;
    readonly transfer: readonly Transferable[];
  }> = [];
  readonly terminate = vi.fn();

  postMessage(message: HostToEngineMessage, transfer: Transferable[] = []): void {
    this.posts.push({ message, transfer });
    if (message.kind === 'dispose')
      queueMicrotask(() =>
        this.dispatchEvent(new MessageEvent('message', { data: { kind: 'disposed' } })),
      );
    if (message.kind !== 'init') return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: {
          kind: 'ready',
          worldIdentity: 'world-test',
          realm: 'worker',
          workerWebGpu: true,
        },
      } as MessageEvent<EngineToHostMessage>);
    });
  }
}

describe('Engine Worker thick bootstrap channel', () => {
  it('transfers bootstrap data and the realm MessagePort with the canvas', async () => {
    const worker = new FakeWorker();
    const offscreen = {} as OffscreenCanvas;
    const transferControlToOffscreen = vi.fn(() => offscreen);
    const channel = new MessageChannel();
    const started = await startEngineWorker({
      canvas: { transferControlToOffscreen } as unknown as HTMLCanvasElement,
      bootstrapUrl: 'https://example.test/bootstrap.js',
      bootstrapData: { gameId: 'sample' },
      bootstrapPort: channel.port2,
      assetCatalog: {
        url: '/__pack/scopes/sample/7/catalog.json',
        expectedScope: { scopeId: 'sample', generation: 7 },
      },
      build: 'build-test',
      timeoutMs: 100,
      workers: workerSelection({ engine: true, render: false, kernels: false }),
      workerFactory: () => worker as unknown as Worker,
    });

    expect(started.ok).toBe(true);
    expect(transferControlToOffscreen).toHaveBeenCalledOnce();
    expect(worker.posts[0]?.message).toMatchObject({
      kind: 'init',
      startupTimeoutMs: 100,
      bootstrapData: { gameId: 'sample' },
      bootstrapPort: channel.port2,
      assetCatalog: {
        url: '/__pack/scopes/sample/7/catalog.json',
        expectedScope: { scopeId: 'sample', generation: 7 },
      },
      build: 'build-test',
    });
    expect(worker.posts[0]?.transfer).toEqual([offscreen, channel.port2]);
    started.ok && (await started.value.dispose()).unwrap();
    channel.port1.close();
  });

  it('rejects non-cloneable data before Worker creation or canvas transfer', async () => {
    const workerFactory = vi.fn();
    const transferControlToOffscreen = vi.fn();
    const started = await startEngineWorker({
      canvas: { transferControlToOffscreen } as unknown as HTMLCanvasElement,
      bootstrapUrl: 'https://example.test/bootstrap.js',
      bootstrapData: { callback: (() => {}) as never },
      timeoutMs: 100,
      workers: workerSelection({ engine: true, render: false, kernels: false }),
      workerFactory,
    });

    expect(started.ok).toBe(false);
    expect(workerFactory).not.toHaveBeenCalled();
    expect(transferControlToOffscreen).not.toHaveBeenCalled();
  });
});

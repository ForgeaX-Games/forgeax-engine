import { World } from '@forgeax/engine-ecs';
import type { Renderer } from '@forgeax/engine-render';
import { describe, expect, it, vi } from 'vitest';
import { commitAttachedWorld, SerializedRebuildQueue } from '../execution/attached-world-swap';

function rendererOwner(): Pick<Renderer, 'attachWorld' | 'detachWorld'> {
  return {
    attachWorld: vi.fn(() => ({ ok: true as const, value: undefined })),
    detachWorld: vi.fn(),
  };
}

describe('worker attached World swap', () => {
  it('serializes concurrent rebuild requests', async () => {
    const queue = new SerializedRebuildQueue();
    const trace: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const first = queue.enqueue(async () => {
      trace.push('first:start');
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      trace.push('first:end');
    });
    const second = queue.enqueue(async () => {
      trace.push('second:start');
      trace.push('second:end');
    });

    await Promise.resolve();
    expect(trace).toEqual(['first:start']);
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(trace).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('publishes the candidate before detaching the previous World', async () => {
    const renderer = rendererOwner();
    const previous = new World();
    const next = new World();

    await expect(commitAttachedWorld(renderer, previous, next, async () => true)).resolves.toBe(
      true,
    );
    expect(renderer.attachWorld).toHaveBeenCalledWith(next);
    expect(renderer.detachWorld).toHaveBeenCalledOnce();
    expect(renderer.detachWorld).toHaveBeenCalledWith(previous);
  });

  it('detaches a candidate whose bootstrap fails and keeps the previous World', async () => {
    const renderer = rendererOwner();
    const previous = new World();
    const next = new World();

    await expect(commitAttachedWorld(renderer, previous, next, async () => false)).resolves.toBe(
      false,
    );
    expect(renderer.detachWorld).toHaveBeenCalledOnce();
    expect(renderer.detachWorld).toHaveBeenCalledWith(next);
    expect(renderer.detachWorld).not.toHaveBeenCalledWith(previous);
  });

  it('detaches a candidate whose bootstrap throws', async () => {
    const renderer = rendererOwner();
    const previous = new World();
    const next = new World();

    await expect(
      commitAttachedWorld(renderer, previous, next, async () => {
        throw new Error('bootstrap failed');
      }),
    ).rejects.toThrow('bootstrap failed');
    expect(renderer.detachWorld).toHaveBeenCalledOnce();
    expect(renderer.detachWorld).toHaveBeenCalledWith(next);
  });
});
